use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    file_access::{
        metadata_times, opened_file_identity, path_to_locator, AuthorizationStore,
        StableMarkdownSnapshot, StableMarkdownState, MAX_DOCUMENT_BYTES,
        MAX_RECOVERY_BASELINE_BYTES,
    },
    request_registry::CancellationToken,
};

pub const CONTRACT_VERSION: u8 = 1;
pub const RECOVERY_RETENTION_DAYS: u64 = 30;
pub const MAX_RECOVERY_TRANSACTIONS_PER_DOCUMENT: usize = 8;
pub const MAX_RECOVERY_BYTES_PER_DOCUMENT: u64 = 320 * 1024 * 1024;

const MAX_RECOVERY_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_RECOVERY_DIRECTORY_ENTRIES: usize = 10_000;
const RECOVERY_ID_HEX_LENGTH: usize = 48;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveIntent {
    Update,
    Create,
    SaveAs,
    Restore,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveRejectionReason {
    Conflict,
    Permission,
    InvalidTarget,
    TooLarge,
    #[serde(rename = "invalidUTF8")]
    InvalidUtf8,
    ResourceExhausted,
    Unavailable,
    Cancelled,
    Internal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveCommitState {
    NotCommitted,
    Committed,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCapabilities {
    readable: bool,
    writable: bool,
    supports_create: bool,
    supports_save_as: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImplementationSemantics {
    write_visibility: &'static str,
    recovery_location: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSnapshot {
    locator: String,
    version: String,
    content_included: bool,
    byte_count: u64,
    capabilities: SnapshotCapabilities,
    implementation_semantics: ImplementationSemantics,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryReference {
    kind: &'static str,
    reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind")]
enum SaveOutcome {
    #[serde(rename = "committed", rename_all = "camelCase")]
    Committed {
        contract_version: u8,
        snapshot: DocumentSnapshot,
        recovery_references: Vec<RecoveryReference>,
    },
    #[serde(rename = "rejected", rename_all = "camelCase")]
    Rejected {
        contract_version: u8,
        reason: SaveRejectionReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_version: Option<String>,
    },
    #[serde(rename = "recoveryRequired", rename_all = "camelCase")]
    RecoveryRequired {
        contract_version: u8,
        commit_state: SaveCommitState,
        recovery_references: Vec<RecoveryReference>,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_version: Option<String>,
    },
}

#[derive(Clone, Debug)]
struct SaveRequest {
    locator: String,
    base_version: Option<String>,
    content: Vec<u8>,
    intent: SaveIntent,
}

pub struct RecoveryCommitRequest {
    pub locator: String,
    pub recovery_id: String,
    pub version: String,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct RecoveryPolicy {
    maximum_transactions: usize,
    maximum_bytes: u64,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            maximum_transactions: MAX_RECOVERY_TRANSACTIONS_PER_DOCUMENT,
            maximum_bytes: MAX_RECOVERY_BYTES_PER_DOCUMENT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifest {
    version: u8,
    recovery_id: String,
    target_key: String,
    phase: String,
    created_at: u64,
    updated_at: u64,
    baseline_revision: Option<String>,
    target_identity: Option<[String; 2]>,
    replacement_identity: Option<[String; 2]>,
    displaced_identity: Option<[String; 2]>,
    commit_revision: Option<String>,
    baseline_sha256: Option<String>,
    attempted_sha256: String,
    baseline_artifact: Option<String>,
    attempted_artifact: String,
    observed_artifact: String,
    temporary_artifact: String,
}

#[derive(Clone, Debug)]
struct TransactionPaths {
    parent: PathBuf,
    manifest: PathBuf,
    manifest_next: PathBuf,
    baseline: PathBuf,
    attempted: PathBuf,
    displaced: PathBuf,
    temporary: PathBuf,
}

impl TransactionPaths {
    fn new(target: &Path, target_key: &str, recovery_id: &str) -> Result<Self, ApiError> {
        let parent = target
            .parent()
            .ok_or_else(|| ApiError::new("INVALID_PATH", "Markdown 文稿路径缺少父目录", 400))?;
        let prefix = format!(".flux-reader-recovery-{target_key}-{recovery_id}");
        Ok(Self {
            parent: parent.to_owned(),
            manifest: parent.join(manifest_sidecar_name(target_key, recovery_id)),
            manifest_next: parent.join(format!("{prefix}-manifest.next")),
            baseline: parent.join(format!("{prefix}-baseline.md")),
            attempted: parent.join(format!("{prefix}-attempted.md")),
            displaced: parent.join(format!("{prefix}-observed.md")),
            temporary: parent.join(format!("{prefix}-replacement.tmp")),
        })
    }

    fn file_name(path: &Path) -> Result<String, ApiError> {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(str::to_owned)
            .ok_or_else(|| ApiError::new("INVALID_PATH", "恢复工件文件名无效", 400))
    }
}

#[derive(Debug)]
struct PreparedTransaction {
    paths: TransactionPaths,
    manifest: RecoveryManifest,
}

#[derive(Clone, Debug)]
struct PublishFailure {
    uncertain_mutation: bool,
    error: ApiError,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestPhase {
    BeforeMutation,
    AfterMutation,
    AfterCommit,
}

#[cfg(test)]
type TestHook = Arc<dyn Fn(TestPhase, &Path) -> Result<(), ApiError> + Send + Sync>;

#[derive(Clone)]
pub struct SafeSaveService {
    locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
    active_recoveries: Arc<Mutex<HashSet<String>>>,
    policy: RecoveryPolicy,
    #[cfg(test)]
    test_hook: Option<TestHook>,
}

impl Default for SafeSaveService {
    fn default() -> Self {
        Self {
            locks: Arc::new(Mutex::new(HashMap::new())),
            active_recoveries: Arc::new(Mutex::new(HashSet::new())),
            policy: RecoveryPolicy::default(),
            #[cfg(test)]
            test_hook: None,
        }
    }
}

struct ActiveRecoveryLease {
    active: Arc<Mutex<HashSet<String>>>,
    recovery_id: String,
}

impl Drop for ActiveRecoveryLease {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.recovery_id);
    }
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(u128::from(u64::MAX)) as u64
        })
}

fn digest_bytes(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn target_key(path: &Path) -> String {
    digest_bytes(path_to_locator(path).as_bytes())[..24].to_owned()
}

fn valid_revision(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_recovery_id(value: &str) -> bool {
    value.len() == RECOVERY_ID_HEX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn manifest_sidecar_name(target_key: &str, recovery_id: &str) -> String {
    format!(".flux-reader-recovery-{target_key}-{recovery_id}-manifest.json")
}

fn parse_manifest_sidecar_name(name: &str) -> Option<(&str, &str)> {
    let core = name
        .strip_prefix(".flux-reader-recovery-")?
        .strip_suffix("-manifest.json")?;
    let (target_key, recovery_id) = core.split_once('-')?;
    if target_key.len() == 24
        && target_key.bytes().all(|byte| byte.is_ascii_hexdigit())
        && valid_recovery_id(recovery_id)
    {
        Some((target_key, recovery_id))
    } else {
        None
    }
}

pub fn is_internal_sidecar_name(name: &str) -> bool {
    let Some(core) = name.strip_prefix(".flux-reader-recovery-") else {
        return false;
    };
    let Some((target_key, remainder)) = core.split_once('-') else {
        return false;
    };
    if target_key.len() != 24 || !target_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let Some((recovery_id, suffix)) = remainder.split_once('-') else {
        return false;
    };
    valid_recovery_id(recovery_id)
        && matches!(
            suffix,
            "manifest.json"
                | "manifest.next"
                | "baseline.md"
                | "attempted.md"
                | "observed.md"
                | "replacement.tmp"
        )
}

fn generate_recovery_id() -> Result<String, ApiError> {
    let mut bytes = [0_u8; RECOVERY_ID_HEX_LENGTH / 2];
    getrandom::fill(&mut bytes).map_err(|_| {
        ApiError::new(
            "RECOVERY_RANDOM_UNAVAILABLE",
            "无法建立不可预测的恢复引用",
            503,
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn classify_error(error: &ApiError) -> SaveRejectionReason {
    match error.error.as_str() {
        "REQUEST_ABORTED" => SaveRejectionReason::Cancelled,
        "FILE_TOO_LARGE" | "RECOVERY_ARTIFACT_TOO_LARGE" => SaveRejectionReason::TooLarge,
        "INVALID_UTF8" => SaveRejectionReason::InvalidUtf8,
        "FILE_CONFLICT"
        | "FILE_CHANGED_DURING_READ"
        | "FILE_CHANGED_DURING_SAVE"
        | "PATH_CHANGED_DURING_AUTHORIZATION"
        | "PATH_CHANGED_DURING_OPEN"
        | "PATH_CHANGED_DURING_SAVE"
        | "RECOVERY_TARGET_CHANGED"
        | "RECOVERY_IN_PROGRESS" => SaveRejectionReason::Conflict,
        "NO_AUTHORIZED_PATH"
        | "PATH_NOT_AUTHORIZED"
        | "PATH_OPEN_DENIED"
        | "STORAGE_WRITE_DENIED"
        | "WEBVIEW_CLOSED" => SaveRejectionReason::Permission,
        "INVALID_PATH"
        | "INVALID_TARGET_TYPE"
        | "INVALID_CONTENT"
        | "INVALID_EXPECTED_REVISION"
        | "INVALID_RECOVERY_ID"
        | "INVALID_RECOVERY_VERSION"
        | "PATH_NOT_FOUND"
        | "RECOVERY_NOT_FOUND"
        | "SYMLINK_SAVE_DENIED"
        | "UNSUPPORTED_DOCUMENT_TYPE" => SaveRejectionReason::InvalidTarget,
        "RECOVERY_BASELINE_TOO_LARGE" | "RECOVERY_QUOTA_EXCEEDED" | "STORAGE_FULL" => {
            SaveRejectionReason::ResourceExhausted
        }
        "PATH_OPEN_FAILED"
        | "PATH_OPEN_UNAVAILABLE"
        | "PRECISE_FILE_STATE_UNAVAILABLE"
        | "RECOVERY_RANDOM_UNAVAILABLE"
        | "RECOVERY_STORAGE_UNAVAILABLE"
        | "STORAGE_WRITE_UNAVAILABLE" => SaveRejectionReason::Unavailable,
        _ => SaveRejectionReason::Internal,
    }
}

fn storage_error(error: &std::io::Error, operation: &str) -> ApiError {
    use std::io::ErrorKind;

    if matches!(error.raw_os_error(), Some(28 | 39 | 112 | 122 | 1816)) {
        return ApiError::new("STORAGE_FULL", format!("{operation}时存储空间不足"), 507);
    }
    match error.kind() {
        ErrorKind::PermissionDenied => {
            ApiError::new("STORAGE_WRITE_DENIED", format!("无权{operation}"), 403)
        }
        ErrorKind::AlreadyExists => {
            ApiError::new("FILE_CONFLICT", format!("{operation}时目标已存在"), 409)
        }
        ErrorKind::NotFound => {
            ApiError::new("PATH_NOT_FOUND", format!("{operation}时目标不存在"), 404)
        }
        ErrorKind::TimedOut | ErrorKind::WouldBlock => ApiError::new(
            "STORAGE_WRITE_UNAVAILABLE",
            format!("存储暂时无法{operation}"),
            503,
        ),
        _ => ApiError::new(
            "STORAGE_WRITE_UNAVAILABLE",
            format!("{operation}时发生存储错误"),
            503,
        ),
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn create_file(
    path: &Path,
    data: &[u8],
    source_permissions: Option<&Metadata>,
) -> Result<[String; 2], ApiError> {
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mode = source_permissions.map_or(0o600, |metadata| {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o7777
        });
        options.mode(mode);
    }
    let mut file = options
        .open(path)
        .map_err(|error| storage_error(&error, "创建恢复工件"))?;
    file.write_all(data)
        .map_err(|error| storage_error(&error, "写入恢复工件"))?;
    if let Some(metadata) = source_permissions {
        fs::set_permissions(path, metadata.permissions())
            .map_err(|error| storage_error(&error, "复制文稿权限"))?;
    }
    file.sync_all()
        .map_err(|error| storage_error(&error, "同步恢复工件"))?;
    opened_file_identity(&file, "恢复工件")
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), ApiError> {
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|error| storage_error(&error, "同步文稿目录"))
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<(), ApiError> {
    // Windows 的正文、sidecar 与 replacement 各自 FlushFileBuffers；发布由
    // ReplaceFileW 完成。标准库没有可移植的目录 Flush 接口。
    Ok(())
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn replace_path(replacement: &Path, target: &Path) -> Result<(), ApiError> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let target = wide_path(target);
    let replacement = wide_path(replacement);
    // SAFETY: 三个 UTF-16 缓冲在调用期间有效并以 NUL 结尾；其余保留参数为空。
    let result = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(storage_error(
            &std::io::Error::last_os_error(),
            "更新恢复清单",
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_path(replacement: &Path, target: &Path) -> Result<(), ApiError> {
    fs::rename(replacement, target).map_err(|error| storage_error(&error, "更新恢复清单"))
}

fn write_initial_manifest(
    paths: &TransactionPaths,
    manifest: &RecoveryManifest,
) -> Result<(), ApiError> {
    let data = serde_json::to_vec(manifest)
        .map_err(|_| ApiError::new("RECOVERY_MANIFEST_FAILED", "无法编码恢复清单", 500))?;
    create_file(&paths.manifest, &data, None)?;
    sync_parent(&paths.parent)
}

fn update_manifest(paths: &TransactionPaths, manifest: &RecoveryManifest) -> Result<(), ApiError> {
    let data = serde_json::to_vec(manifest)
        .map_err(|_| ApiError::new("RECOVERY_MANIFEST_FAILED", "无法编码恢复清单", 500))?;
    create_file(&paths.manifest_next, &data, None)?;
    replace_path(&paths.manifest_next, &paths.manifest)?;
    sync_parent(&paths.parent)
}

fn read_bounded_file(
    path: &Path,
    maximum: u64,
    expected_identity: Option<&[String; 2]>,
) -> Result<(Vec<u8>, [String; 2]), ApiError> {
    let link_metadata =
        fs::symlink_metadata(path).map_err(|error| storage_error(&error, "读取恢复工件"))?;
    if is_reparse_point(&link_metadata) || !link_metadata.is_file() {
        return Err(ApiError::new(
            "RECOVERY_ARTIFACT_INVALID",
            "恢复工件不是安全的普通文件",
            409,
        ));
    }
    if link_metadata.len() > maximum {
        return Err(ApiError::new(
            "RECOVERY_ARTIFACT_TOO_LARGE",
            "恢复工件超过安全读取上限",
            413,
        ));
    }
    let canonical =
        fs::canonicalize(path).map_err(|error| storage_error(&error, "解析恢复工件"))?;
    if canonical != path {
        return Err(ApiError::new(
            "RECOVERY_ARTIFACT_INVALID",
            "恢复工件路径已被替换",
            409,
        ));
    }
    let mut file = File::open(path).map_err(|error| storage_error(&error, "打开恢复工件"))?;
    let identity = opened_file_identity(&file, "恢复工件")?;
    if expected_identity.is_some_and(|expected| expected != &identity) {
        return Err(ApiError::new(
            "RECOVERY_ARTIFACT_INVALID",
            "恢复工件身份已变化",
            409,
        ));
    }
    let opened_metadata = file
        .metadata()
        .map_err(|error| storage_error(&error, "读取恢复工件元数据"))?;
    let mut data = Vec::with_capacity(opened_metadata.len() as usize);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|error| storage_error(&error, "读取恢复工件"))?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..read]);
        if data.len() as u64 > maximum {
            return Err(ApiError::new(
                "RECOVERY_ARTIFACT_TOO_LARGE",
                "恢复工件在读取期间超过安全上限",
                413,
            ));
        }
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| storage_error(&error, "复核恢复工件元数据"))?;
    let final_identity = opened_file_identity(&file, "恢复工件")?;
    if final_identity != identity
        || final_metadata.len() != opened_metadata.len()
        || data.len() as u64 != final_metadata.len()
    {
        return Err(ApiError::new(
            "RECOVERY_ARTIFACT_CHANGED",
            "恢复工件在读取期间发生变化",
            409,
        ));
    }
    Ok((data, identity))
}

#[cfg(target_os = "macos")]
fn publish_existing(
    target: &Path,
    replacement: &Path,
    displaced: &Path,
) -> Result<(), PublishFailure> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    // 与生产 Windows ReplaceFileW 相同，测试路径也使用一次原子 exchange：
    // pathname 不会经历缺口，旧 occupant 直接落在 durable displaced sidecar。
    if let Err(error) = fs::hard_link(target, displaced) {
        return Err(PublishFailure {
            uncertain_mutation: false,
            error: storage_error(&error, "保留被替换文稿"),
        });
    }
    let target_c = CString::new(target.as_os_str().as_bytes()).map_err(|_| PublishFailure {
        uncertain_mutation: false,
        error: ApiError::new("INVALID_PATH", "原子替换路径包含无效字符", 400),
    })?;
    let replacement_c =
        CString::new(replacement.as_os_str().as_bytes()).map_err(|_| PublishFailure {
            uncertain_mutation: false,
            error: ApiError::new("INVALID_PATH", "原子替换路径包含无效字符", 400),
        })?;
    // SAFETY: 两个 CString 在调用期间有效且以 NUL 结尾；RENAME_SWAP 只交换
    // 同目录两个现存普通文件的 pathname，不删除任一 inode。
    let result =
        unsafe { libc::renamex_np(replacement_c.as_ptr(), target_c.as_ptr(), libc::RENAME_SWAP) };
    if result != 0 {
        return Err(PublishFailure {
            // hard-link 只建立恢复别名；exchange 失败时 target 仍是原 occupant，
            // 因此可以证明本事务没有覆盖用户可见正文。
            uncertain_mutation: false,
            error: storage_error(&std::io::Error::last_os_error(), "原子替换文稿"),
        });
    }
    // exchange 后旧 occupant 也位于 replacement；只 best-effort 移除这个额外
    // hard-link。失败不会降格已提交的正文，显式恢复清理会再次删除该别名。
    let _ = fs::remove_file(replacement);
    Ok(())
}

#[cfg(windows)]
fn publish_existing(
    target: &Path,
    replacement: &Path,
    displaced: &Path,
) -> Result<(), PublishFailure> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let target_wide = wide_path(target);
    let replacement_wide = wide_path(replacement);
    let displaced_wide = wide_path(displaced);
    // SAFETY: 路径缓冲在调用期间有效且以 NUL 结尾；ReplaceFileW 在同卷上
    // 原子发布 replacement，并把原 pathname occupant 保留到 displaced。
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            replacement_wide.as_ptr(),
            displaced_wide.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        let error = std::io::Error::last_os_error();
        Err(PublishFailure {
            // ReplaceFileW 的部分失败码可能发生在重命名序列中间；仅凭 backup
            // 是否可见不能证明 target 未变化，统一进入显式恢复最安全。
            uncertain_mutation: true,
            error: storage_error(&error, "原子替换文稿"),
        })
    } else {
        Ok(())
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn publish_existing(
    target: &Path,
    replacement: &Path,
    displaced: &Path,
) -> Result<(), PublishFailure> {
    // hard-link 让旧 inode 在 rename 后仍有名字。外部进程持有的旧 fd 晚到
    // 写入会落到 displaced，而不会因 pathname 原子替换而丢失。
    if let Err(error) = fs::hard_link(target, displaced) {
        return Err(PublishFailure {
            uncertain_mutation: false,
            error: storage_error(&error, "保留被替换文稿"),
        });
    }
    if let Err(error) = fs::rename(replacement, target) {
        return Err(PublishFailure {
            uncertain_mutation: false,
            error: storage_error(&error, "原子替换文稿"),
        });
    }
    Ok(())
}

fn publish_new(replacement: &Path, target: &Path) -> Result<(), PublishFailure> {
    // hard_link(create-new) 是同目录、绝不覆盖的原子 pathname 创建屏障；成功后
    // 立刻移除临时别名，避免 sidecar 名称长期指向已提交正文的同一 inode。
    if let Err(error) = fs::hard_link(replacement, target) {
        return Err(PublishFailure {
            uncertain_mutation: false,
            error: storage_error(&error, "原子创建文稿"),
        });
    }
    if let Err(error) = fs::remove_file(replacement) {
        return Err(PublishFailure {
            uncertain_mutation: true,
            error: storage_error(&error, "移除已发布文稿的临时别名"),
        });
    }
    Ok(())
}

fn committed_outcome(
    locator: &str,
    snapshot: &StableMarkdownSnapshot,
    recovery_references: Vec<RecoveryReference>,
) -> SaveOutcome {
    SaveOutcome::Committed {
        contract_version: CONTRACT_VERSION,
        snapshot: DocumentSnapshot {
            locator: locator.to_owned(),
            version: snapshot.revision.clone(),
            content_included: false,
            byte_count: snapshot.data.len() as u64,
            capabilities: SnapshotCapabilities {
                readable: true,
                writable: snapshot.writable,
                supports_create: false,
                supports_save_as: false,
            },
            implementation_semantics: ImplementationSemantics {
                write_visibility: "atomicReplace",
                recovery_location: "sidecar",
            },
        },
        recovery_references,
    }
}

fn recovery_reference(recovery_id: &str, phase: &str) -> RecoveryReference {
    RecoveryReference {
        kind: "retainedSidecar",
        reference: format!("sidecar:{recovery_id}"),
        phase: Some(phase.to_owned()),
    }
}

fn manifest_owns_identity(manifest: &RecoveryManifest, identity: &[String; 2]) -> bool {
    manifest.target_identity.as_ref() == Some(identity)
        || manifest.replacement_identity.as_ref() == Some(identity)
}

impl SafeSaveService {
    pub fn invalid_request(&self, message: impl Into<String>) -> ApiError {
        self.rejected(ApiError::new("INVALID_CONTENT", message.into(), 400), None)
    }

    fn lock_for(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(path.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn begin_recovery(&self, recovery_id: &str) -> ActiveRecoveryLease {
        self.active_recoveries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(recovery_id.to_owned());
        ActiveRecoveryLease {
            active: Arc::clone(&self.active_recoveries),
            recovery_id: recovery_id.to_owned(),
        }
    }

    #[cfg(test)]
    fn run_hook(&self, phase: TestPhase, target: &Path) -> Result<(), ApiError> {
        if let Some(hook) = &self.test_hook {
            hook(phase, target)?;
        }
        Ok(())
    }

    fn rejected(&self, mut error: ApiError, current_version: Option<String>) -> ApiError {
        let outcome = SaveOutcome::Rejected {
            contract_version: CONTRACT_VERSION,
            reason: classify_error(&error),
            current_version: current_version.clone(),
        };
        error.details = Some(json!({
            "error": error.error,
            "message": error.message,
            "currentRevision": current_version,
            "saveOutcome": outcome
        }));
        error
    }

    fn recovery_required(
        &self,
        mut error: ApiError,
        transaction: &mut PreparedTransaction,
        current: Option<&StableMarkdownSnapshot>,
    ) -> ApiError {
        transaction.manifest.phase = "recovery-required".to_owned();
        transaction.manifest.updated_at = current_time_millis();
        if let Some(snapshot) = current
            .filter(|snapshot| manifest_owns_identity(&transaction.manifest, &snapshot.identity))
        {
            transaction.manifest.target_identity = Some(snapshot.identity.clone());
            transaction.manifest.commit_revision = Some(snapshot.revision.clone());
        }
        let _ = update_manifest(&transaction.paths, &transaction.manifest);
        let current_version = current.map(|snapshot| snapshot.revision.clone());
        let reference = recovery_reference(&transaction.manifest.recovery_id, "recovery-required");
        let outcome = SaveOutcome::RecoveryRequired {
            contract_version: CONTRACT_VERSION,
            commit_state: SaveCommitState::Unknown,
            recovery_references: vec![reference],
            current_version: current_version.clone(),
        };
        error.error = "SAVE_RECOVERY_REQUIRED".to_owned();
        error.status = 409;
        error.details = Some(json!({
            "error": error.error,
            "message": error.message,
            "currentRevision": current_version,
            "recoveryRequired": true,
            "recovery": {
                "available": true,
                "recoveryId": transaction.manifest.recovery_id,
                "phase": "recovery-required"
            },
            "saveOutcome": outcome
        }));
        error
    }

    fn assert_capacity(
        &self,
        parent: &Path,
        target_key: &str,
        reservation: u64,
    ) -> Result<(), ApiError> {
        let prefix = format!(".flux-reader-recovery-{target_key}-");
        let mut entries_seen = 0_usize;
        let mut transactions = 0_usize;
        let mut bytes = 0_u64;
        for item in fs::read_dir(parent).map_err(|error| storage_error(&error, "检查恢复配额"))?
        {
            entries_seen += 1;
            if entries_seen > MAX_RECOVERY_DIRECTORY_ENTRIES {
                return Err(ApiError::new(
                    "RECOVERY_STORAGE_UNAVAILABLE",
                    "文稿目录条目过多，无法安全核验恢复配额",
                    503,
                ));
            }
            let item = item.map_err(|error| storage_error(&error, "检查恢复配额"))?;
            let name = item.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&prefix) {
                continue;
            }
            let metadata = fs::symlink_metadata(item.path())
                .map_err(|error| storage_error(&error, "检查恢复工件"))?;
            if is_reparse_point(&metadata) || !metadata.is_file() {
                return Err(ApiError::new(
                    "RECOVERY_STORAGE_UNAVAILABLE",
                    "恢复工件集合包含不安全条目",
                    503,
                ));
            }
            bytes = bytes.saturating_add(metadata.len());
            if name.ends_with("-manifest.json") {
                transactions += 1;
            }
        }
        if transactions >= self.policy.maximum_transactions
            || bytes.saturating_add(reservation) > self.policy.maximum_bytes
        {
            return Err(ApiError::new(
                "RECOVERY_QUOTA_EXCEEDED",
                "恢复 sidecar 已达到安全配额，请先处理现有恢复记录",
                507,
            ));
        }
        Ok(())
    }

    fn prepare_transaction(
        &self,
        target: &Path,
        baseline: Option<&StableMarkdownSnapshot>,
        attempted: &[u8],
    ) -> Result<PreparedTransaction, ApiError> {
        let recovery_id = generate_recovery_id()?;
        let target_key = target_key(target);
        let paths = TransactionPaths::new(target, &target_key, &recovery_id)?;
        let reservation = baseline.map_or(0, |snapshot| snapshot.data.len() as u64 * 2)
            + attempted.len() as u64 * 2
            + MAX_RECOVERY_MANIFEST_BYTES;
        self.assert_capacity(&paths.parent, &target_key, reservation)?;

        let now = current_time_millis();
        let mut manifest = RecoveryManifest {
            version: CONTRACT_VERSION,
            recovery_id,
            target_key,
            phase: "preparing".to_owned(),
            created_at: now,
            updated_at: now,
            baseline_revision: baseline.map(|snapshot| snapshot.revision.clone()),
            target_identity: baseline.map(|snapshot| snapshot.identity.clone()),
            replacement_identity: None,
            displaced_identity: None,
            commit_revision: None,
            baseline_sha256: baseline.map(|snapshot| digest_bytes(&snapshot.data)),
            attempted_sha256: digest_bytes(attempted),
            baseline_artifact: baseline
                .map(|_| TransactionPaths::file_name(&paths.baseline))
                .transpose()?,
            attempted_artifact: TransactionPaths::file_name(&paths.attempted)?,
            observed_artifact: TransactionPaths::file_name(&paths.displaced)?,
            temporary_artifact: TransactionPaths::file_name(&paths.temporary)?,
        };
        write_initial_manifest(&paths, &manifest)?;
        if let Some(snapshot) = baseline {
            create_file(&paths.baseline, &snapshot.data, None)?;
        }
        create_file(&paths.attempted, attempted, None)?;
        let replacement_identity = create_file(
            &paths.temporary,
            attempted,
            baseline.map(|snapshot| &snapshot.metadata),
        )?;
        manifest.replacement_identity = Some(replacement_identity);
        manifest.phase = "prepared".to_owned();
        manifest.updated_at = current_time_millis();
        update_manifest(&paths, &manifest)?;
        sync_parent(&paths.parent)?;
        Ok(PreparedTransaction { paths, manifest })
    }

    fn committed_response(
        &self,
        locator: &str,
        snapshot: StableMarkdownSnapshot,
        transaction: Option<&mut PreparedTransaction>,
        include_content: bool,
    ) -> Value {
        let mut references = Vec::new();
        let mut cleanup_pending = false;
        if let Some(transaction) = transaction {
            transaction.manifest.phase = "committed".to_owned();
            transaction.manifest.updated_at = current_time_millis();
            transaction.manifest.target_identity = Some(snapshot.identity.clone());
            transaction.manifest.commit_revision = Some(snapshot.revision.clone());
            references.push(recovery_reference(
                &transaction.manifest.recovery_id,
                "committed",
            ));
            if update_manifest(&transaction.paths, &transaction.manifest).is_err() {
                cleanup_pending = true;
                references.push(RecoveryReference {
                    kind: "cleanupPending",
                    reference: format!("sidecar-cleanup:{}", transaction.manifest.recovery_id),
                    phase: Some("committed".to_owned()),
                });
            }
        }
        #[cfg(test)]
        if self
            .run_hook(TestPhase::AfterCommit, &snapshot.canonical)
            .is_err()
        {
            cleanup_pending = true;
            references.push(RecoveryReference {
                kind: "cleanupPending",
                reference: "windows-post-commit-diagnostics".to_owned(),
                phase: Some("committed".to_owned()),
            });
        }
        let outcome = committed_outcome(locator, &snapshot, references);
        let (mtime, ctime) = metadata_times(&snapshot.metadata);
        let mut response = json!({
            "actualPath": path_to_locator(&snapshot.canonical),
            "size": snapshot.data.len(),
            "mtime": mtime,
            "ctime": ctime,
            "revision": snapshot.revision,
            "writable": snapshot.writable,
            "saveSemantics": "atomic-replace",
            "externalAtomicity": "atomic-path-replace",
            "recoveryCleanupPending": cleanup_pending,
            "saveOutcome": outcome
        });
        // 普通 PUT /file 保持既有响应形状；恢复提交不把 sidecar 正文重新送入
        // WebView，尤其避免把 10--16 MiB 的仅恢复版本变成新的浏览器缓存副本。
        if include_content {
            response
                .as_object_mut()
                .expect("save response is an object")
                .insert(
                    "content".to_owned(),
                    Value::String(String::from_utf8_lossy(&snapshot.data).into_owned()),
                );
        }
        response
    }

    pub fn save_update(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        locator: String,
        content: String,
        expected_revision: Option<String>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        self.save_request(
            files,
            webview,
            SaveRequest {
                locator,
                base_version: expected_revision,
                content: content.into_bytes(),
                intent: SaveIntent::Update,
            },
            cancellation,
        )
    }

    fn save_request(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        request: SaveRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let maximum_content_bytes = if request.intent == SaveIntent::Restore {
            MAX_RECOVERY_BASELINE_BYTES
        } else {
            MAX_DOCUMENT_BYTES
        };
        if request.content.len() as u64 > maximum_content_bytes {
            let (code, message) = if request.intent == SaveIntent::Restore {
                (
                    "RECOVERY_ARTIFACT_TOO_LARGE",
                    "恢复正文超过 16 MiB 恢复工件上限",
                )
            } else {
                ("FILE_TOO_LARGE", "文稿超过 10 MiB 保存上限")
            };
            return Err(self.rejected(ApiError::new(code, message, 413), None));
        }
        if std::str::from_utf8(&request.content).is_err() {
            return Err(self.rejected(
                ApiError::new("INVALID_UTF8", "保存正文不是有效的 UTF-8", 422),
                None,
            ));
        }
        match request.intent {
            SaveIntent::Update | SaveIntent::Restore => {
                self.save_existing(files, webview, request, cancellation)
            }
            SaveIntent::Create | SaveIntent::SaveAs => {
                self.save_new(files, webview, request, cancellation)
            }
        }
    }

    fn save_existing(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        request: SaveRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        files
            .assert_safe_save_locator(&request.locator)
            .map_err(|error| self.rejected(error, None))?;
        let Some(base_version) = request
            .base_version
            .as_deref()
            .filter(|value| valid_revision(value))
        else {
            return Err(self.rejected(
                ApiError::new(
                    "INVALID_EXPECTED_REVISION",
                    "expectedRevision 必须来自最近一次文件快照",
                    400,
                ),
                None,
            ));
        };
        let recovery_restore = request.intent == SaveIntent::Restore;
        let first = if recovery_restore {
            files.stable_recovery_snapshot(webview, &request.locator, cancellation)
        } else {
            files.stable_markdown_snapshot(webview, &request.locator, cancellation)
        }
        .map_err(|error| self.rejected(error, None))?;
        let lock = self.lock_for(&first.canonical);
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let baseline = if recovery_restore {
            files.stable_recovery_snapshot(webview, &request.locator, cancellation)
        } else {
            files.stable_markdown_snapshot(webview, &request.locator, cancellation)
        }
        .map_err(|error| self.rejected(error, None))?;
        if baseline.revision != base_version {
            return Err(self.rejected(
                ApiError::new("FILE_CONFLICT", "文稿已被外部修改，请重新加载", 409),
                Some(baseline.revision),
            ));
        }
        if !recovery_restore && std::str::from_utf8(&baseline.data).is_err() {
            return Err(self.rejected(
                ApiError::new("INVALID_UTF8", "磁盘文稿不是有效的 UTF-8", 422),
                Some(baseline.revision),
            ));
        }
        if !baseline.writable {
            return Err(self.rejected(
                ApiError::new("STORAGE_WRITE_DENIED", "当前文稿不可写", 403),
                Some(baseline.revision),
            ));
        }
        if baseline.data == request.content {
            let current = (if recovery_restore {
                files.stable_recovery_snapshot(webview, &request.locator, cancellation)
            } else {
                files.stable_markdown_snapshot(webview, &request.locator, cancellation)
            })
            .map_err(|error| self.rejected(error, Some(baseline.revision.clone())))?;
            if current.revision != baseline.revision {
                return Err(self.rejected(
                    ApiError::new("FILE_CONFLICT", "文稿在保存前发生变化", 409),
                    Some(current.revision),
                ));
            }
            if !current.writable {
                return Err(self.rejected(
                    ApiError::new("STORAGE_WRITE_DENIED", "当前文稿不可写", 403),
                    Some(current.revision),
                ));
            }
            return Ok(self.committed_response(&request.locator, current, None, !recovery_restore));
        }

        let mut transaction = self
            .prepare_transaction(&baseline.canonical, Some(&baseline), &request.content)
            .map_err(|error| self.rejected(error, Some(baseline.revision.clone())))?;
        let _active = self.begin_recovery(&transaction.manifest.recovery_id);
        #[cfg(test)]
        self.run_hook(TestPhase::BeforeMutation, &baseline.canonical)
            .map_err(|error| self.rejected(error, Some(baseline.revision.clone())))?;
        cancellation
            .check()
            .map_err(|error| self.rejected(error, Some(baseline.revision.clone())))?;
        let authorization_gate = files.commit_authorization_gate();
        // gate 的读锁只覆盖最终授权/CAS 与 publish；若窗口销毁已开始，写锁
        // 会先完成撤权，本请求随后在 final_check 以 permission fail closed。
        let _authorization_guard = authorization_gate
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let final_check = (if recovery_restore {
            files.stable_recovery_snapshot(webview, &request.locator, cancellation)
        } else {
            files.stable_markdown_snapshot(webview, &request.locator, cancellation)
        })
        .map_err(|error| {
            let mapped = if matches!(
                error.error.as_str(),
                "WEBVIEW_CLOSED"
                    | "NO_AUTHORIZED_PATH"
                    | "PATH_NOT_AUTHORIZED"
                    | "PATH_OPEN_DENIED"
            ) {
                error
            } else {
                ApiError::new("FILE_CONFLICT", "文稿在提交前被替换", 409)
            };
            self.rejected(mapped, Some(baseline.revision.clone()))
        })?;
        if final_check.identity != baseline.identity
            || final_check.revision != baseline.revision
            || final_check.canonical != baseline.canonical
        {
            return Err(self.rejected(
                ApiError::new("FILE_CONFLICT", "文稿在提交前发生变化", 409),
                Some(final_check.revision),
            ));
        }
        if !final_check.writable {
            return Err(self.rejected(
                ApiError::new("STORAGE_WRITE_DENIED", "提交前写权限已撤销", 403),
                Some(final_check.revision),
            ));
        }
        cancellation
            .check()
            .map_err(|error| self.rejected(error, Some(final_check.revision.clone())))?;

        if let Err(failure) = publish_existing(
            &baseline.canonical,
            &transaction.paths.temporary,
            &transaction.paths.displaced,
        ) {
            if !failure.uncertain_mutation {
                return Err(self.rejected(failure.error, Some(final_check.revision)));
            }
            let current = (if recovery_restore {
                files.stable_recovery_snapshot(
                    webview,
                    &request.locator,
                    &CancellationToken::default(),
                )
            } else {
                files.stable_markdown_snapshot(
                    webview,
                    &request.locator,
                    &CancellationToken::default(),
                )
            })
            .ok();
            return Err(self.recovery_required(
                ApiError::new(
                    "SAVE_STATE_UNKNOWN",
                    format!("无法确认原子替换的最终状态：{}", failure.error.message),
                    500,
                ),
                &mut transaction,
                current.as_ref(),
            ));
        }

        #[cfg(test)]
        if let Err(error) = self.run_hook(TestPhase::AfterMutation, &baseline.canonical) {
            let current = (if recovery_restore {
                files.stable_recovery_snapshot(
                    webview,
                    &request.locator,
                    &CancellationToken::default(),
                )
            } else {
                files.stable_markdown_snapshot(
                    webview,
                    &request.locator,
                    &CancellationToken::default(),
                )
            })
            .ok();
            return Err(self.recovery_required(error, &mut transaction, current.as_ref()));
        }
        let committed = match if recovery_restore {
            files.stable_recovery_snapshot(webview, &request.locator, &CancellationToken::default())
        } else {
            files.stable_markdown_snapshot(webview, &request.locator, &CancellationToken::default())
        } {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Err(self.recovery_required(error, &mut transaction, None));
            }
        };
        let expected_replacement = transaction
            .manifest
            .replacement_identity
            .as_ref()
            .expect("prepared transaction has replacement identity");
        if committed.data != request.content || &committed.identity != expected_replacement {
            return Err(self.recovery_required(
                ApiError::new("FILE_CONFLICT", "原子发布后目标被外部进程改写", 409),
                &mut transaction,
                Some(&committed),
            ));
        }
        let (displaced_data, displaced_identity) = match read_bounded_file(
            &transaction.paths.displaced,
            if recovery_restore {
                MAX_RECOVERY_BASELINE_BYTES
            } else {
                MAX_DOCUMENT_BYTES
            },
            Some(&baseline.identity),
        ) {
            Ok(value) => value,
            Err(error) => {
                return Err(self.recovery_required(error, &mut transaction, Some(&committed)));
            }
        };
        transaction.manifest.displaced_identity = Some(displaced_identity);
        if displaced_data != baseline.data {
            return Err(self.recovery_required(
                ApiError::new("FILE_CONFLICT", "被替换版本在提交窗口内被外部进程改写", 409),
                &mut transaction,
                Some(&committed),
            ));
        }
        if let Err(error) = sync_parent(&transaction.paths.parent) {
            return Err(self.recovery_required(error, &mut transaction, Some(&committed)));
        }

        Ok(self.committed_response(
            &request.locator,
            committed,
            Some(&mut transaction),
            !recovery_restore,
        ))
    }

    fn save_new(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        request: SaveRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        if request.base_version.is_some() {
            return Err(self.rejected(
                ApiError::new(
                    "INVALID_EXPECTED_REVISION",
                    "create/saveAs 目标不能携带已有版本",
                    400,
                ),
                None,
            ));
        }
        let target = files
            .new_markdown_target(webview, &request.locator)
            .map_err(|error| self.rejected(error, None))?;
        let lock = self.lock_for(&target);
        let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        if fs::symlink_metadata(&target).is_ok() {
            return Err(self.rejected(
                ApiError::new("FILE_CONFLICT", "另一个进程已创建目标文稿", 409),
                None,
            ));
        }
        let mut transaction = self
            .prepare_transaction(&target, None, &request.content)
            .map_err(|error| self.rejected(error, None))?;
        let _active = self.begin_recovery(&transaction.manifest.recovery_id);
        #[cfg(test)]
        self.run_hook(TestPhase::BeforeMutation, &target)
            .map_err(|error| self.rejected(error, None))?;
        cancellation
            .check()
            .map_err(|error| self.rejected(error, None))?;
        let authorization_gate = files.commit_authorization_gate();
        let _authorization_guard = authorization_gate
            .read()
            .unwrap_or_else(|error| error.into_inner());
        // create/saveAs 同样在持 gate 时重验 session 授权；目录重解析点变化
        // 会由 new_markdown_target 的 canonicalize + 前缀校验 fail closed。
        let final_target = files
            .new_markdown_target(webview, &request.locator)
            .map_err(|error| self.rejected(error, None))?;
        if final_target != target {
            return Err(self.rejected(
                ApiError::new("FILE_CONFLICT", "目标目录在提交前发生变化", 409),
                None,
            ));
        }
        if let Err(failure) = publish_new(&transaction.paths.temporary, &target) {
            if !failure.uncertain_mutation {
                return Err(self.rejected(failure.error, None));
            }
            let current = files
                .stable_markdown_snapshot(webview, &request.locator, &CancellationToken::default())
                .ok();
            return Err(self.recovery_required(failure.error, &mut transaction, current.as_ref()));
        }
        #[cfg(test)]
        if let Err(error) = self.run_hook(TestPhase::AfterMutation, &target) {
            let current = files
                .stable_markdown_snapshot(webview, &request.locator, &CancellationToken::default())
                .ok();
            return Err(self.recovery_required(error, &mut transaction, current.as_ref()));
        }
        let committed = match files.stable_markdown_snapshot(
            webview,
            &request.locator,
            &CancellationToken::default(),
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Err(self.recovery_required(error, &mut transaction, None));
            }
        };
        if committed.data != request.content
            || transaction.manifest.replacement_identity.as_ref() != Some(&committed.identity)
        {
            return Err(self.recovery_required(
                ApiError::new("FILE_CONFLICT", "新建文稿在提交窗口内被改写", 409),
                &mut transaction,
                Some(&committed),
            ));
        }
        if let Err(error) = sync_parent(&transaction.paths.parent) {
            return Err(self.recovery_required(error, &mut transaction, Some(&committed)));
        }
        Ok(self.committed_response(&request.locator, committed, Some(&mut transaction), true))
    }

    fn manifest_paths_for(
        &self,
        target: &Path,
        recovery_id: &str,
    ) -> Result<TransactionPaths, ApiError> {
        if !valid_recovery_id(recovery_id) {
            return Err(ApiError::new(
                "INVALID_RECOVERY_ID",
                "recoveryId 格式无效",
                400,
            ));
        }
        TransactionPaths::new(target, &target_key(target), recovery_id)
    }

    fn read_manifest(
        &self,
        target: &Path,
        recovery_id: &str,
    ) -> Result<(TransactionPaths, RecoveryManifest), ApiError> {
        let paths = self.manifest_paths_for(target, recovery_id)?;
        let (data, _) = read_bounded_file(&paths.manifest, MAX_RECOVERY_MANIFEST_BYTES, None)
            .map_err(|_| ApiError::new("RECOVERY_NOT_FOUND", "恢复记录不存在", 404))?;
        let manifest: RecoveryManifest = serde_json::from_slice(&data)
            .map_err(|_| ApiError::new("RECOVERY_NOT_FOUND", "恢复记录无效", 404))?;
        let baseline_name = TransactionPaths::file_name(&paths.baseline)?;
        let baseline_valid = match (
            manifest.baseline_artifact.as_deref(),
            manifest.baseline_sha256.as_deref(),
        ) {
            (Some(artifact), Some(_)) => artifact == baseline_name,
            (None, None) => true,
            _ => false,
        };
        let valid = manifest.version == CONTRACT_VERSION
            && manifest.recovery_id == recovery_id
            && manifest.target_key == target_key(target)
            && baseline_valid
            && manifest.attempted_artifact == TransactionPaths::file_name(&paths.attempted)?
            && manifest.observed_artifact == TransactionPaths::file_name(&paths.displaced)?
            && manifest.temporary_artifact == TransactionPaths::file_name(&paths.temporary)?;
        if !valid {
            return Err(ApiError::new(
                "RECOVERY_NOT_FOUND",
                "恢复记录不存在或不属于当前文稿",
                404,
            ));
        }
        Ok((paths, manifest))
    }

    fn artifact_available(
        &self,
        path: &Path,
        expected_sha256: Option<&str>,
        expected_identity: Option<&[String; 2]>,
    ) -> bool {
        read_bounded_file(path, MAX_RECOVERY_BASELINE_BYTES, expected_identity).is_ok_and(
            |(data, _)| match expected_sha256 {
                Some(digest) => digest_bytes(&data) == digest,
                None => true,
            },
        )
    }

    fn recovery_records(&self, target: &StableMarkdownState) -> Result<Vec<Value>, ApiError> {
        let key = target_key(&target.canonical);
        let prefix = format!(".flux-reader-recovery-{key}-");
        let suffix = "-manifest.json";
        let mut records = Vec::new();
        let mut entries_seen = 0_usize;
        for item in fs::read_dir(
            target
                .canonical
                .parent()
                .ok_or_else(|| ApiError::new("INVALID_PATH", "Markdown 文稿路径缺少父目录", 400))?,
        )
        .map_err(|error| storage_error(&error, "列出恢复记录"))?
        {
            entries_seen += 1;
            if entries_seen > MAX_RECOVERY_DIRECTORY_ENTRIES {
                return Err(ApiError::new(
                    "RECOVERY_STORAGE_UNAVAILABLE",
                    "文稿目录条目过多，无法安全列出恢复记录",
                    503,
                ));
            }
            let item = item.map_err(|error| storage_error(&error, "列出恢复记录"))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let Some((parsed_key, recovery_id)) = parse_manifest_sidecar_name(&name) else {
                continue;
            };
            if parsed_key != key || !name.starts_with(&prefix) || !name.ends_with(suffix) {
                continue;
            }
            let Ok((paths, manifest)) = self.read_manifest(&target.canonical, recovery_id) else {
                continue;
            };
            // prepared 清单仍指向 baseline；发布成功但 phase 更新失败时目标已经
            // 是 replacement。两者都属于事务，陌生竞争者 inode 绝不能被重新绑定。
            let target_matches = manifest_owns_identity(&manifest, &target.identity);
            let baseline_available = manifest
                .baseline_sha256
                .as_deref()
                .is_some_and(|digest| self.artifact_available(&paths.baseline, Some(digest), None));
            let attempted_available =
                self.artifact_available(&paths.attempted, Some(&manifest.attempted_sha256), None);
            let observed_available = manifest
                .displaced_identity
                .as_ref()
                .is_some_and(|identity| {
                    self.artifact_available(&paths.displaced, None, Some(identity))
                });
            let in_progress = self
                .active_recoveries
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(recovery_id);
            records.push(json!({
                "recoveryId": recovery_id,
                "phase": manifest.phase,
                "createdAt": manifest.created_at.to_string(),
                "updatedAt": manifest.updated_at.to_string(),
                "baselineRevision": manifest.baseline_revision,
                "targetMatches": target_matches,
                "baselineAvailable": baseline_available,
                "attemptedAvailable": attempted_available,
                "observedAvailable": observed_available,
                "currentMatchesAttempt": target_matches
                    && target.content_sha256 == manifest.attempted_sha256,
                "inProgress": in_progress
            }));
        }
        records.sort_by(|left, right| right["updatedAt"].as_str().cmp(&left["updatedAt"].as_str()));
        Ok(records)
    }

    pub fn recovery_state(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let target = files.stable_markdown_state(webview, locator, cancellation)?;
        let records = self.recovery_records(&target)?;
        Ok(json!({
            "available": !records.is_empty(),
            "records": records
        }))
    }

    pub fn attach_recovery(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        locator: &str,
        value: &mut Value,
        cancellation: &CancellationToken,
    ) {
        let recovery = self
            .recovery_state(files, webview, locator, cancellation)
            .unwrap_or_else(|_| {
                json!({
                    "available": false,
                    "diagnosticsUnavailable": true
                })
            });
        if let Some(object) = value.as_object_mut() {
            object.insert("recovery".to_owned(), recovery);
        }
    }

    fn recovery_bytes(
        &self,
        target: &StableMarkdownState,
        recovery_id: &str,
        version: &str,
    ) -> Result<(Vec<u8>, RecoveryManifest), ApiError> {
        let (paths, manifest) = self.read_manifest(&target.canonical, recovery_id)?;
        if !manifest_owns_identity(&manifest, &target.identity) {
            return Err(ApiError::new(
                "RECOVERY_TARGET_CHANGED",
                "当前路径已指向另一份文稿，不能读取旧恢复正文",
                409,
            ));
        }
        let data = match version {
            "baseline" => {
                let digest = manifest.baseline_sha256.as_deref().ok_or_else(|| {
                    ApiError::new("RECOVERY_NOT_FOUND", "恢复记录没有 baseline", 404)
                })?;
                let (data, _) =
                    read_bounded_file(&paths.baseline, MAX_RECOVERY_BASELINE_BYTES, None)?;
                if digest_bytes(&data) != digest {
                    return Err(ApiError::new(
                        "RECOVERY_ARTIFACT_INVALID",
                        "baseline 完整性校验失败",
                        409,
                    ));
                }
                data
            }
            "attempted" => {
                let (data, _) =
                    read_bounded_file(&paths.attempted, MAX_RECOVERY_BASELINE_BYTES, None)?;
                if digest_bytes(&data) != manifest.attempted_sha256 {
                    return Err(ApiError::new(
                        "RECOVERY_ARTIFACT_INVALID",
                        "attempted 完整性校验失败",
                        409,
                    ));
                }
                data
            }
            "observed" => {
                let identity = manifest.displaced_identity.as_ref().ok_or_else(|| {
                    ApiError::new("RECOVERY_NOT_FOUND", "恢复记录没有 observed", 404)
                })?;
                read_bounded_file(
                    &paths.displaced,
                    MAX_RECOVERY_BASELINE_BYTES,
                    Some(identity),
                )?
                .0
            }
            _ => {
                return Err(ApiError::new(
                    "INVALID_RECOVERY_VERSION",
                    "version 必须是 baseline、attempted 或 observed",
                    400,
                ));
            }
        };
        Ok((data, manifest))
    }

    pub fn read_recovery_version(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        locator: &str,
        recovery_id: &str,
        version: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        cancellation.check()?;
        let target = files.stable_markdown_state(webview, locator, cancellation)?;
        let (data, manifest) = self.recovery_bytes(&target, recovery_id, version)?;
        cancellation.check()?;
        let content = String::from_utf8(data)
            .map_err(|_| ApiError::new("INVALID_UTF8", "恢复正文不是有效的 UTF-8", 422))?;
        Ok(json!({
            "recoveryId": recovery_id,
            "version": version,
            "phase": manifest.phase,
            "size": content.len(),
            "sha256": digest_bytes(content.as_bytes()),
            "content": content
        }))
    }

    pub fn commit_recovery(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        request: RecoveryCommitRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let target = files
            .stable_markdown_state(webview, &request.locator, cancellation)
            .map_err(|error| self.rejected(error, None))?;
        let (data, _) = self
            .recovery_bytes(&target, &request.recovery_id, &request.version)
            .map_err(|error| self.rejected(error, Some(target.revision.clone())))?;
        let content = String::from_utf8(data).map_err(|_| {
            self.rejected(
                ApiError::new("INVALID_UTF8", "恢复正文不是有效的 UTF-8", 422),
                Some(target.revision.clone()),
            )
        })?;
        self.save_request(
            files,
            webview,
            SaveRequest {
                locator: request.locator,
                base_version: request.expected_revision,
                content: content.into_bytes(),
                intent: SaveIntent::Restore,
            },
            cancellation,
        )
    }

    pub fn discard_recovery(
        &self,
        files: &AuthorizationStore,
        webview: &str,
        locator: &str,
        recovery_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        cancellation.check()?;
        let target = files.stable_markdown_state(webview, locator, cancellation)?;
        let lock = self.lock_for(&target.canonical);
        let _guard: MutexGuard<'_, ()> = lock.lock().unwrap_or_else(|error| error.into_inner());
        let (paths, _) = self.read_manifest(&target.canonical, recovery_id)?;
        if self
            .active_recoveries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(recovery_id)
        {
            return Err(ApiError::new(
                "RECOVERY_IN_PROGRESS",
                "保存事务仍在进行，暂不能丢弃恢复记录",
                409,
            ));
        }
        cancellation.check()?;
        for path in [
            &paths.manifest_next,
            &paths.temporary,
            &paths.displaced,
            &paths.attempted,
            &paths.baseline,
            &paths.manifest,
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(&error, "清理恢复工件")),
            }
        }
        sync_parent(&paths.parent)?;
        Ok(json!({ "recoveryId": recovery_id, "discarded": true }))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Seek, SeekFrom},
        sync::{Arc, Barrier},
        thread,
    };

    use filetime::{set_file_times, FileTime};
    use serde::Deserialize;
    use tempfile::TempDir;

    use super::*;
    use crate::file_access::AuthorizationKind;

    const ORIGINAL: &str = "original content";
    const NEW_CONTENT: &str = "new saved content";
    const EXTERNAL: &str = "external content";

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScenarioCorpus {
        contract_version: u8,
        scenarios: Vec<Scenario>,
    }

    #[derive(Debug, Deserialize)]
    struct Scenario {
        id: String,
        expected: ScenarioExpected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScenarioExpected {
        kind: String,
        reason: Option<SaveRejectionReason>,
        commit_state: Option<SaveCommitState>,
        disk: String,
    }

    struct ScenarioObservation {
        outcome: Value,
        disk: String,
    }

    fn corpus() -> ScenarioCorpus {
        serde_json::from_str(include_str!(
            "../../../../contracts/safe-save/v1/scenarios.json"
        ))
        .expect("共享 safe-save 场景必须是有效 JSON")
    }

    fn setup_file(content: &str) -> (TempDir, PathBuf, AuthorizationStore) {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, content).unwrap();
        let files = AuthorizationStore::default();
        files
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        (directory, target, files)
    }

    fn snapshot(files: &AuthorizationStore, target: &Path) -> StableMarkdownSnapshot {
        files
            .stable_markdown_snapshot(
                "main",
                &path_to_locator(target),
                &CancellationToken::default(),
            )
            .unwrap()
    }

    fn outcome(result: &Result<Value, ApiError>) -> Value {
        match result {
            Ok(value) => value["saveOutcome"].clone(),
            Err(error) => error
                .details
                .as_ref()
                .and_then(|details| details.get("saveOutcome"))
                .cloned()
                .unwrap_or_else(|| panic!("{} 缺少 saveOutcome", error.error)),
        }
    }

    fn hooked_service<F>(hook: F) -> SafeSaveService
    where
        F: Fn(TestPhase, &Path) -> Result<(), ApiError> + Send + Sync + 'static,
    {
        SafeSaveService {
            test_hook: Some(Arc::new(hook)),
            ..SafeSaveService::default()
        }
    }

    fn save(
        service: &SafeSaveService,
        files: &AuthorizationStore,
        target: &Path,
        content: &str,
        base_version: Option<String>,
    ) -> Result<Value, ApiError> {
        service.save_request(
            files,
            "main",
            SaveRequest {
                locator: path_to_locator(target),
                base_version,
                content: content.as_bytes().to_vec(),
                intent: SaveIntent::Update,
            },
            &CancellationToken::default(),
        )
    }

    fn observe_disk(target: &Path, result: &Result<Value, ApiError>, new_content: &str) -> String {
        if outcome(result)["kind"] == "recoveryRequired" {
            return "explicitRecovery".to_owned();
        }
        let data = fs::read_to_string(target).unwrap();
        if data == new_content {
            "newContent"
        } else if data == ORIGINAL {
            "originalContent"
        } else if data == EXTERNAL {
            "externalContent"
        } else {
            panic!("场景留下了未分类磁盘正文：{data:?}");
        }
        .to_owned()
    }

    fn run_scenario(id: &str) -> ScenarioObservation {
        match id {
            "normal-update" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    NEW_CONTENT,
                    Some(snapshot(&files, &target).revision),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "same-content-no-op" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    ORIGINAL,
                    Some(snapshot(&files, &target).revision),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "stale-base-version" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                fs::write(&target, EXTERNAL).unwrap();
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    NEW_CONTENT,
                    Some(base),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "same-size-and-time-content-change" => {
                let (_directory, target, files) = setup_file("alpha");
                let original_metadata = fs::metadata(&target).unwrap();
                let original_time = FileTime::from_last_modification_time(&original_metadata);
                let base = snapshot(&files, &target).revision;
                fs::write(&target, "bravo").unwrap();
                set_file_times(&target, original_time, original_time).unwrap();
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    NEW_CONTENT,
                    Some(base),
                );
                assert_eq!(fs::read_to_string(&target).unwrap(), "bravo");
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: "externalContent".to_owned(),
                }
            }
            "target-replaced-before-commit" | "late-external-writer" => {
                let (directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let replacement = directory.path().join("external.tmp");
                let target_for_hook = target.clone();
                let service = hooked_service(move |phase, _| {
                    if phase == TestPhase::BeforeMutation {
                        fs::write(&replacement, EXTERNAL).unwrap();
                        fs::rename(&replacement, &target_for_hook).unwrap();
                    }
                    Ok(())
                });
                let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "permission-revoked-before-commit" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let files_for_hook = files.clone();
                let service = hooked_service(move |phase, _| {
                    if phase == TestPhase::BeforeMutation {
                        files_for_hook.remove_webview("main");
                    }
                    Ok(())
                });
                let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "concurrent-same-base" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let first = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    NEW_CONTENT,
                    Some(base.clone()),
                );
                assert_eq!(outcome(&first)["kind"], "committed");
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    "losing content",
                    Some(base),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "failure-before-mutation" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let service = hooked_service(|phase, _| {
                    if phase == TestPhase::BeforeMutation {
                        return Err(ApiError::new(
                            "STORAGE_WRITE_UNAVAILABLE",
                            "注入 mutation 前失败",
                            503,
                        ));
                    }
                    Ok(())
                });
                let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "failure-after-mutation" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let service = hooked_service(|phase, _| {
                    if phase == TestPhase::AfterMutation {
                        return Err(ApiError::new(
                            "STORAGE_WRITE_UNAVAILABLE",
                            "注入 mutation 后失败",
                            503,
                        ));
                    }
                    Ok(())
                });
                let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
                let recovery = service
                    .recovery_state(
                        &files,
                        "main",
                        &path_to_locator(&target),
                        &CancellationToken::default(),
                    )
                    .unwrap();
                assert_eq!(recovery["available"], true);
                assert_eq!(recovery["records"][0]["baselineAvailable"], true);
                assert_eq!(recovery["records"][0]["attemptedAvailable"], true);
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "recovery-quota-full" => {
                let (_directory, target, files) = setup_file(ORIGINAL);
                let base = snapshot(&files, &target).revision;
                let service = SafeSaveService {
                    policy: RecoveryPolicy {
                        maximum_transactions: 0,
                        maximum_bytes: 0,
                    },
                    ..SafeSaveService::default()
                };
                let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "invalid-input-or-target" => {
                let directory = tempfile::tempdir().unwrap();
                let target = directory.path().join("note.txt");
                fs::write(&target, ORIGINAL).unwrap();
                let files = AuthorizationStore::default();
                files
                    .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
                    .unwrap();
                let result = save(
                    &SafeSaveService::default(),
                    &files,
                    &target,
                    NEW_CONTENT,
                    Some("a".repeat(64)),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            "create-target-race" => {
                let directory = tempfile::tempdir().unwrap();
                let target = directory.path().join("new.md");
                let files = AuthorizationStore::default();
                files
                    .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
                    .unwrap();
                let target_for_hook = target.clone();
                let service = hooked_service(move |phase, _| {
                    if phase == TestPhase::BeforeMutation {
                        fs::write(&target_for_hook, EXTERNAL).unwrap();
                    }
                    Ok(())
                });
                let result = service.save_request(
                    &files,
                    "main",
                    SaveRequest {
                        locator: path_to_locator(&target),
                        base_version: None,
                        content: NEW_CONTENT.as_bytes().to_vec(),
                        intent: SaveIntent::SaveAs,
                    },
                    &CancellationToken::default(),
                );
                ScenarioObservation {
                    outcome: outcome(&result),
                    disk: observe_disk(&target, &result, NEW_CONTENT),
                }
            }
            _ => panic!("共享契约新增了未适配场景：{id}"),
        }
    }

    #[test]
    fn shared_contract_adapter_runs_all_thirteen_scenarios() {
        let corpus = corpus();
        assert_eq!(corpus.contract_version, CONTRACT_VERSION);
        assert_eq!(corpus.scenarios.len(), 13);
        let unique = corpus
            .scenarios
            .iter()
            .map(|scenario| scenario.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(unique.len(), corpus.scenarios.len());

        for scenario in corpus.scenarios {
            let observation = run_scenario(&scenario.id);
            assert_eq!(
                observation.outcome["kind"], scenario.expected.kind,
                "{}",
                scenario.id
            );
            if let Some(reason) = scenario.expected.reason {
                assert_eq!(
                    serde_json::from_value::<SaveRejectionReason>(
                        observation.outcome["reason"].clone()
                    )
                    .unwrap(),
                    reason,
                    "{}",
                    scenario.id
                );
            }
            if let Some(commit_state) = scenario.expected.commit_state {
                assert_eq!(
                    serde_json::from_value::<SaveCommitState>(
                        observation.outcome["commitState"].clone()
                    )
                    .unwrap(),
                    commit_state,
                    "{}",
                    scenario.id
                );
            }
            assert_eq!(observation.disk, scenario.expected.disk, "{}", scenario.id);
        }
    }

    #[test]
    fn rejection_reasons_stay_exhaustive_with_shared_schema() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../contracts/safe-save/v1/schema.json"
        ))
        .unwrap();
        let from_schema = schema["$defs"]["rejectionReason"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<HashSet<_>>();
        let rust_reasons = [
            SaveRejectionReason::Conflict,
            SaveRejectionReason::Permission,
            SaveRejectionReason::InvalidTarget,
            SaveRejectionReason::TooLarge,
            SaveRejectionReason::InvalidUtf8,
            SaveRejectionReason::ResourceExhausted,
            SaveRejectionReason::Unavailable,
            SaveRejectionReason::Cancelled,
            SaveRejectionReason::Internal,
        ]
        .into_iter()
        .map(|reason| {
            serde_json::to_value(reason)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<HashSet<_>>();
        assert_eq!(rust_reasons, from_schema);
    }

    #[test]
    fn concurrent_same_base_requests_commit_exactly_once() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let base = snapshot(&files, &target).revision;
        let service = SafeSaveService::default();
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for content in ["first writer", "second writer"] {
            let barrier = Arc::clone(&barrier);
            let service = service.clone();
            let files = files.clone();
            let target = target.clone();
            let base = base.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                save(&service, &files, &target, content, Some(base))
            }));
        }
        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|handle| outcome(&handle.join().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|value| value["kind"] == "committed")
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|value| value["kind"] == "rejected" && value["reason"] == "conflict")
                .count(),
            1
        );
    }

    #[test]
    fn successful_create_removes_the_temporary_inode_alias() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("created.md");
        let files = AuthorizationStore::default();
        files
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        let service = SafeSaveService::default();
        let result = service
            .save_request(
                &files,
                "main",
                SaveRequest {
                    locator: path_to_locator(&target),
                    base_version: None,
                    content: NEW_CONTENT.as_bytes().to_vec(),
                    intent: SaveIntent::SaveAs,
                },
                &CancellationToken::default(),
            )
            .unwrap();

        assert_eq!(result["saveOutcome"]["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), NEW_CONTENT);
        let names = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!names.iter().any(|name| name.ends_with("-replacement.tmp")));
    }

    #[test]
    fn late_writer_to_displaced_inode_is_retained_without_overwriting_target() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let mut late_writer = OpenOptions::new().write(true).open(&target).unwrap();
        let base = snapshot(&files, &target).revision;
        let service = SafeSaveService::default();
        let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
        assert_eq!(outcome(&result)["kind"], "committed");

        late_writer.set_len(0).unwrap();
        late_writer.seek(SeekFrom::Start(0)).unwrap();
        late_writer.write_all(EXTERNAL.as_bytes()).unwrap();
        late_writer.sync_all().unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), NEW_CONTENT);

        let state = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let recovery_id = state["records"][0]["recoveryId"].as_str().unwrap();
        let observed = service
            .read_recovery_version(
                &files,
                "main",
                &path_to_locator(&target),
                recovery_id,
                "observed",
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(observed["content"], EXTERNAL);
    }

    #[test]
    fn recovery_versions_require_explicit_commit_and_discard_lifecycle() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let service = SafeSaveService::default();
        let initial = snapshot(&files, &target);
        let result = save(
            &service,
            &files,
            &target,
            NEW_CONTENT,
            Some(initial.revision),
        );
        assert_eq!(outcome(&result)["kind"], "committed");
        let state = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let recovery_id = state["records"][0]["recoveryId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(state["records"][0]["baselineAvailable"], true);
        assert_eq!(state["records"][0]["attemptedAvailable"], true);

        let current = snapshot(&files, &target);
        let restored = service
            .commit_recovery(
                &files,
                "main",
                RecoveryCommitRequest {
                    locator: path_to_locator(&target),
                    recovery_id: recovery_id.clone(),
                    version: "baseline".to_owned(),
                    expected_revision: Some(current.revision),
                },
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(restored["saveOutcome"]["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), ORIGINAL);

        service
            .discard_recovery(
                &files,
                "main",
                &path_to_locator(&target),
                &recovery_id,
                &CancellationToken::default(),
            )
            .unwrap();
        let state = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        assert!(state["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["recoveryId"] != recovery_id));
    }

    #[test]
    fn oversized_current_file_still_exposes_and_commits_recovery_with_fresh_cas() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let service = SafeSaveService::default();
        let initial = snapshot(&files, &target);
        let result = save(
            &service,
            &files,
            &target,
            NEW_CONTENT,
            Some(initial.revision),
        );
        assert_eq!(outcome(&result)["kind"], "committed");
        let recovery = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let recovery_id = recovery["records"][0]["recoveryId"]
            .as_str()
            .unwrap()
            .to_owned();

        File::create(&target)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let state = files
            .stable_markdown_state(
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(state.content_sha256.len(), 64);
        let recovery = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(recovery["records"][0]["recoveryId"], recovery_id);

        let restored = service
            .commit_recovery(
                &files,
                "main",
                RecoveryCommitRequest {
                    locator: path_to_locator(&target),
                    recovery_id,
                    version: "baseline".to_owned(),
                    expected_revision: Some(state.revision),
                },
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(restored["saveOutcome"]["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), ORIGINAL);
    }

    #[test]
    fn recovery_commit_rejects_current_file_above_hard_limit_before_mutation() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let service = SafeSaveService::default();
        let initial = snapshot(&files, &target);
        let result = save(
            &service,
            &files,
            &target,
            NEW_CONTENT,
            Some(initial.revision),
        );
        assert_eq!(outcome(&result)["kind"], "committed");
        let recovery = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let recovery_id = recovery["records"][0]["recoveryId"]
            .as_str()
            .unwrap()
            .to_owned();

        File::create(&target)
            .unwrap()
            .set_len(MAX_RECOVERY_BASELINE_BYTES + 1)
            .unwrap();
        let state = files
            .stable_markdown_state(
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let before = fs::metadata(&target).unwrap();
        let rejected = service
            .commit_recovery(
                &files,
                "main",
                RecoveryCommitRequest {
                    locator: path_to_locator(&target),
                    recovery_id,
                    version: "baseline".to_owned(),
                    expected_revision: Some(state.revision),
                },
                &CancellationToken::default(),
            )
            .unwrap_err();
        assert_eq!(rejected.error, "RECOVERY_BASELINE_TOO_LARGE");
        assert_eq!(rejected.status, 413);
        assert_eq!(rejected.details.unwrap()["saveOutcome"]["kind"], "rejected");
        let after = fs::metadata(&target).unwrap();
        assert_eq!(after.len(), MAX_RECOVERY_BASELINE_BYTES + 1);
        assert_eq!(
            opened_file_identity(&File::open(&target).unwrap(), "文稿").unwrap(),
            state.identity
        );
        assert_eq!(before.len(), after.len());
    }

    #[test]
    fn invalid_utf8_current_file_can_be_recovered_without_browser_decoding() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let service = SafeSaveService::default();
        let initial = snapshot(&files, &target);
        let result = save(
            &service,
            &files,
            &target,
            NEW_CONTENT,
            Some(initial.revision),
        );
        assert_eq!(outcome(&result)["kind"], "committed");
        let recovery = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let recovery_id = recovery["records"][0]["recoveryId"]
            .as_str()
            .unwrap()
            .to_owned();

        fs::write(&target, [0xff, 0xfe]).unwrap();
        let state = files
            .stable_markdown_state(
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        assert!(files
            .read_markdown(
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .is_err());
        let restored = service
            .commit_recovery(
                &files,
                "main",
                RecoveryCommitRequest {
                    locator: path_to_locator(&target),
                    recovery_id,
                    version: "attempted".to_owned(),
                    expected_revision: Some(state.revision),
                },
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(restored["saveOutcome"]["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), NEW_CONTENT);
    }

    #[test]
    fn recovery_commit_accepts_exact_hard_limit_without_returning_private_content() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let service = SafeSaveService::default();
        let current = snapshot(&files, &target);
        let recovery_content = vec![b'a'; MAX_RECOVERY_BASELINE_BYTES as usize];
        let transaction = service
            .prepare_transaction(&current.canonical, Some(&current), &recovery_content)
            .unwrap();
        let recovery_id = transaction.manifest.recovery_id.clone();
        let mut manifest = transaction.manifest.clone();
        manifest.phase = "recovery-required".to_owned();
        manifest.updated_at = current_time_millis();
        update_manifest(&transaction.paths, &manifest).unwrap();
        drop(transaction);

        let restored = service
            .commit_recovery(
                &files,
                "main",
                RecoveryCommitRequest {
                    locator: path_to_locator(&target),
                    recovery_id,
                    version: "attempted".to_owned(),
                    expected_revision: Some(current.revision),
                },
                &CancellationToken::default(),
            )
            .unwrap();
        assert_eq!(restored["saveOutcome"]["kind"], "committed");
        assert_eq!(restored["size"], MAX_RECOVERY_BASELINE_BYTES);
        assert!(restored.get("content").is_none());
        assert_eq!(
            fs::metadata(&target).unwrap().len(),
            MAX_RECOVERY_BASELINE_BYTES
        );
        assert_eq!(
            files
                .stable_markdown_snapshot(
                    "main",
                    &path_to_locator(&target),
                    &CancellationToken::default(),
                )
                .unwrap_err()
                .error,
            "FILE_TOO_LARGE"
        );
    }

    #[test]
    fn unknown_external_path_occupant_cannot_claim_recovery_artifacts() {
        let (directory, target, files) = setup_file(ORIGINAL);
        let base = snapshot(&files, &target).revision;
        let replacement = directory.path().join("external.tmp");
        let target_for_hook = target.clone();
        let service = hooked_service(move |phase, _| {
            if phase == TestPhase::AfterMutation {
                fs::write(&replacement, EXTERNAL).unwrap();
                fs::rename(&replacement, &target_for_hook).unwrap();
                return Err(ApiError::new(
                    "STORAGE_WRITE_UNAVAILABLE",
                    "注入 mutation 后竞争者替换",
                    503,
                ));
            }
            Ok(())
        });
        let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
        assert_eq!(outcome(&result)["kind"], "recoveryRequired");
        assert_eq!(fs::read_to_string(&target).unwrap(), EXTERNAL);

        let state = service
            .recovery_state(
                &files,
                "main",
                &path_to_locator(&target),
                &CancellationToken::default(),
            )
            .unwrap();
        let record = &state["records"][0];
        assert_eq!(record["targetMatches"], false);
        let recovery_id = record["recoveryId"].as_str().unwrap();
        assert_eq!(
            service
                .read_recovery_version(
                    &files,
                    "main",
                    &path_to_locator(&target),
                    recovery_id,
                    "attempted",
                    &CancellationToken::default(),
                )
                .unwrap_err()
                .error,
            "RECOVERY_TARGET_CHANGED"
        );
    }

    #[test]
    fn post_commit_diagnostic_failure_never_downgrades_committed_outcome() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let base = snapshot(&files, &target).revision;
        let service = hooked_service(|phase, _| {
            if phase == TestPhase::AfterCommit {
                return Err(ApiError::new(
                    "METADATA_READ_FAILED",
                    "注入 commit 后诊断失败",
                    500,
                ));
            }
            Ok(())
        });
        let result = save(&service, &files, &target, NEW_CONTENT, Some(base)).unwrap();
        assert_eq!(result["saveOutcome"]["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), NEW_CONTENT);
        assert!(result["saveOutcome"]["recoveryReferences"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["kind"] == "cleanupPending"));
    }

    #[test]
    fn authorization_revocation_waits_for_the_commit_barrier() {
        let (_directory, target, files) = setup_file(ORIGINAL);
        let base = snapshot(&files, &target).revision;
        let files_for_hook = files.clone();
        let target_for_hook = target.clone();
        let hook_reached = Arc::new(Barrier::new(2));
        let revoke_finished = Arc::new(Barrier::new(2));
        let hook_reached_for_hook = Arc::clone(&hook_reached);
        let revoke_finished_for_hook = Arc::clone(&revoke_finished);
        let service = hooked_service(move |phase, _| {
            if phase == TestPhase::AfterMutation {
                hook_reached_for_hook.wait();
                assert!(files_for_hook
                    .stable_markdown_snapshot(
                        "main",
                        &path_to_locator(&target_for_hook),
                        &CancellationToken::default(),
                    )
                    .is_ok());
                revoke_finished_for_hook.wait();
            }
            Ok(())
        });

        let service_for_save = service.clone();
        let files_for_save = files.clone();
        let target_for_save = target.clone();
        let save_thread = thread::spawn(move || {
            save(
                &service_for_save,
                &files_for_save,
                &target_for_save,
                NEW_CONTENT,
                Some(base),
            )
        });
        hook_reached.wait();
        let files_for_revoke = files.clone();
        let revoker = thread::spawn(move || files_for_revoke.remove_webview("main"));
        thread::yield_now();
        assert!(!revoker.is_finished());
        revoke_finished.wait();
        let result = save_thread.join().unwrap();
        revoker.join().unwrap();
        assert_eq!(outcome(&result)["kind"], "committed");
        assert_eq!(fs::read_to_string(&target).unwrap(), NEW_CONTENT);
        assert_eq!(
            files
                .stable_markdown_snapshot(
                    "main",
                    &path_to_locator(&target),
                    &CancellationToken::default(),
                )
                .unwrap_err()
                .error,
            "WEBVIEW_CLOSED"
        );
    }

    #[test]
    fn recovery_references_never_expose_private_sidecar_paths() {
        let (directory, target, files) = setup_file(ORIGINAL);
        let base = snapshot(&files, &target).revision;
        let service = hooked_service(|phase, _| {
            if phase == TestPhase::AfterMutation {
                return Err(ApiError::new("FAIL_AFTER_MUTATION", "注入失败", 500));
            }
            Ok(())
        });
        let result = save(&service, &files, &target, NEW_CONTENT, Some(base));
        let serialized = serde_json::to_string(&outcome(&result)).unwrap();
        assert!(!serialized.contains(&path_to_locator(directory.path())));
        assert!(!serialized.contains(".flux-reader-recovery-"));
        assert!(serialized.contains("sidecar:"));
    }
}
