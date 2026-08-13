use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

use crate::safe_save::is_internal_sidecar_name;
use crate::{error::ApiError, request_registry::CancellationToken};

pub const MAX_DOCUMENT_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
// 与 fnOS 恢复 hard limit 对齐：普通编辑仍限制为 10 MiB，但恢复提交必须能先
// 保全一个已经超出编辑上限的当前版本，不能为了恢复而无基线覆盖它。
pub const MAX_RECOVERY_BASELINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SELECTED_WORKSPACES: usize = 8;
const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_TREE_DEPTH: usize = 20;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_SEARCH_RESULTS: usize = 100;
const MAX_SEARCH_QUERY_LENGTH: usize = 256;
const MAX_SEARCH_CONTENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEARCH_CONTENT_FILES: usize = 1_000;

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];
const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("gif", "image/gif"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("png", "image/png"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("webp", "image/webp"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizationKind {
    File,
    Directory,
}

#[derive(Clone, Debug)]
struct AuthorizedRoot {
    canonical: PathBuf,
    kind: AuthorizationKind,
}

/** 授权只驻留内存，并按 WebView 隔离；正文与目录内容不会写入这里。 */
#[derive(Clone, Default)]
pub struct AuthorizationStore {
    roots: Arc<RwLock<HashMap<String, Vec<AuthorizedRoot>>>>,
    closed_webviews: Arc<RwLock<HashSet<String>>>,
    // commit barrier 的读锁覆盖最终授权校验与 pathname 发布；窗口销毁持写锁，
    // 因此“先撤销、后发布”的竞态不能越过最后一道授权边界。
    commit_gate: Arc<RwLock<()>>,
}

#[derive(Debug)]
struct AuthorizedTarget {
    canonical: PathBuf,
    metadata: Metadata,
}

#[derive(Debug)]
pub(crate) struct StableMarkdownSnapshot {
    pub canonical: PathBuf,
    pub data: Vec<u8>,
    pub metadata: Metadata,
    pub identity: [String; 2],
    pub revision: String,
    pub writable: bool,
}

#[derive(Debug)]
pub(crate) struct StableMarkdownState {
    pub canonical: PathBuf,
    pub metadata: Metadata,
    pub identity: [String; 2],
    pub revision: String,
    pub writable: bool,
    pub content_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    size: u64,
    mtime: f64,
    ctime: f64,
}

#[derive(Clone, Debug)]
struct ListedEntry {
    public: DirectoryEntry,
    canonical: PathBuf,
}

#[derive(Clone, Debug)]
struct Workspace {
    requested_path: String,
    canonical: PathBuf,
    metadata: Metadata,
}

#[derive(Clone, Debug)]
struct TreeRecord {
    entry: ListedEntry,
    relative_path: String,
}

#[derive(Debug)]
struct TreeScan {
    records: Vec<TreeRecord>,
    truncated: bool,
}

struct TreeScanOptions<'a> {
    budget: &'a mut usize,
    truncate_on_limit: bool,
    excluded_roots: &'a [PathBuf],
    include_images: bool,
}

fn io_error(error: &std::io::Error, kind: &str) -> ApiError {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => ApiError::new("PATH_NOT_FOUND", format!("{kind}不存在"), 404),
        ErrorKind::PermissionDenied => {
            ApiError::new("PATH_OPEN_DENIED", format!("无权打开{kind}"), 403)
        }
        ErrorKind::InvalidInput => ApiError::new("INVALID_PATH", format!("{kind}路径无效"), 400),
        ErrorKind::TimedOut | ErrorKind::WouldBlock => ApiError::new(
            "PATH_OPEN_UNAVAILABLE",
            format!("存储暂时无法打开{kind}"),
            503,
        ),
        _ => ApiError::new("PATH_OPEN_FAILED", format!("打开{kind}时发生存储错误"), 500),
    }
}

fn parse_locator(value: &str, kind: &str) -> Result<PathBuf, ApiError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(ApiError::new(
            "INVALID_PATH",
            format!("{kind}必须是有效的绝对路径"),
            400,
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.components().any(|item| item == Component::ParentDir) {
        return Err(ApiError::new(
            "INVALID_PATH",
            format!("{kind}必须是有效的绝对路径"),
            400,
        ));
    }
    Ok(path)
}

/** Rust 内部保留 PathBuf；跨 IPC 时固定用正斜杠，并移除 Windows verbatim 前缀。 */
pub fn path_to_locator(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(network) = normalized.strip_prefix("//?/UNC/") {
        format!("//{network}")
    } else if let Some(local) = normalized.strip_prefix("//?/") {
        local.to_owned()
    } else {
        normalized
    }
}

fn canonicalize(path: &Path, kind: &str) -> Result<PathBuf, ApiError> {
    fs::canonicalize(path).map_err(|error| io_error(&error, kind))
}

#[cfg(windows)]
fn opened_file_path(file: &File, kind: &str) -> Result<PathBuf, ApiError> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    // GetFinalPathNameByHandleW 把校验绑定到已经打开的 HANDLE，关闭
    // canonicalize 与 File::open 之间重解析点被 ABA 替换的窗口。
    let handle = file.as_raw_handle();
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            std::ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 || required > 32_768 {
        return Err(ApiError::new(
            "OPENED_HANDLE_RESOLUTION_FAILED",
            format!("无法解析已打开{kind}的真实路径"),
            500,
        ));
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(ApiError::new(
            "OPENED_HANDLE_RESOLUTION_FAILED",
            format!("无法解析已打开{kind}的真实路径"),
            500,
        ));
    }
    let opened = PathBuf::from(OsString::from_wide(&buffer[..written as usize]));
    canonicalize(&opened, kind)
}

#[cfg(not(windows))]
fn opened_file_path(_file: &File, fallback: &Path, kind: &str) -> Result<PathBuf, ApiError> {
    canonicalize(fallback, kind)
}

#[cfg(windows)]
fn opened_path(file: &File, fallback: &Path, kind: &str) -> Result<PathBuf, ApiError> {
    let _ = fallback;
    opened_file_path(file, kind)
}

#[cfg(not(windows))]
fn opened_path(file: &File, fallback: &Path, kind: &str) -> Result<PathBuf, ApiError> {
    opened_file_path(file, fallback, kind)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| MARKDOWN_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .find_map(|(candidate, mime)| (*candidate == extension).then_some(*mime))
}

fn parse_local_resource_source(raw_source: &str) -> Result<(PathBuf, bool), ApiError> {
    if raw_source.is_empty() || raw_source.len() > 4096 || raw_source.contains('\0') {
        return Err(ApiError::new("INVALID_RESOURCE_PATH", "图片路径无效", 400));
    }
    let without_suffix = raw_source.split(['?', '#']).next().unwrap_or_default();
    let encoded = without_suffix.as_bytes();
    for (index, byte) in encoded.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= encoded.len()
                || !encoded[index + 1].is_ascii_hexdigit()
                || !encoded[index + 2].is_ascii_hexdigit())
        {
            return Err(ApiError::new(
                "INVALID_RESOURCE_PATH",
                "图片路径编码无效",
                400,
            ));
        }
    }
    let decoded = percent_decode_str(without_suffix)
        .decode_utf8()
        .map_err(|_| ApiError::new("INVALID_RESOURCE_PATH", "图片路径编码无效", 400))?;
    if decoded.is_empty()
        || decoded.contains('\0')
        || decoded.contains('\\')
        || decoded.starts_with("//")
        || decoded.find(':').is_some_and(|index| {
            let prefix = decoded[..index].as_bytes();
            prefix.first().is_some_and(u8::is_ascii_alphabetic)
                && prefix[1..]
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        })
    {
        return Err(ApiError::new("INVALID_RESOURCE_PATH", "图片路径无效", 400));
    }
    let root_relative = decoded.starts_with('/');
    let relative = decoded.trim_start_matches('/');
    if relative.is_empty() {
        return Err(ApiError::new(
            "INVALID_RESOURCE_PATH",
            "图片路径不能为空",
            400,
        ));
    }
    Ok((PathBuf::from(relative), root_relative))
}

fn lexical_resource_candidate(
    base: &Path,
    root: &Path,
    relative: &Path,
) -> Result<PathBuf, ApiError> {
    let mut candidate = base.to_owned();
    for component in relative.components() {
        match component {
            Component::Normal(value) => candidate.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if candidate == root || !candidate.pop() || !candidate.starts_with(root) {
                    return Err(ApiError::new(
                        "RESOURCE_OUTSIDE_WORKSPACE",
                        "图片路径超出资源工作区",
                        403,
                    ));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(ApiError::new("INVALID_RESOURCE_PATH", "图片路径无效", 400));
            }
        }
    }
    if candidate == root || !candidate.starts_with(root) {
        return Err(ApiError::new(
            "RESOURCE_OUTSIDE_WORKSPACE",
            "图片路径超出资源工作区",
            403,
        ));
    }
    Ok(candidate)
}

fn path_is_strictly_within(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

fn has_image_signature(data: &[u8], mime_type: &str) -> bool {
    let ascii = |start: usize, end: usize| std::str::from_utf8(&data[start..end]).ok();
    match mime_type {
        "image/png" => data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => {
            data.len() >= 12 && ascii(0, 4) == Some("RIFF") && ascii(8, 12) == Some("WEBP")
        }
        "image/bmp" => data.starts_with(b"BM"),
        "image/tiff" => {
            data.starts_with(&[b'I', b'I', 42, 0]) || data.starts_with(&[b'M', b'M', 0, 42])
        }
        "image/avif" => {
            data.len() >= 12
                && ascii(4, 8) == Some("ftyp")
                && matches!(ascii(8, 12), Some("avif" | "avis"))
        }
        "image/heic" | "image/heif" => {
            data.len() >= 12
                && ascii(4, 8) == Some("ftyp")
                && matches!(
                    ascii(8, 12),
                    Some("heic" | "heix" | "hevc" | "hevx" | "heim" | "heis" | "mif1" | "msf1")
                )
        }
        _ => false,
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

fn milliseconds(time: Result<SystemTime, std::io::Error>) -> f64 {
    time.ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0)
}

pub(crate) fn metadata_times(metadata: &Metadata) -> (f64, f64) {
    (
        milliseconds(metadata.modified()),
        milliseconds(metadata.created()),
    )
}

#[cfg(windows)]
fn precise_metadata_fields(metadata: &Metadata) -> [String; 4] {
    use std::os::windows::fs::MetadataExt;

    [
        metadata.file_attributes().to_string(),
        metadata.file_size().to_string(),
        metadata.last_write_time().to_string(),
        metadata.creation_time().to_string(),
    ]
}

#[cfg(unix)]
fn precise_metadata_fields(metadata: &Metadata) -> [String; 4] {
    use std::os::unix::fs::MetadataExt;

    [
        metadata.dev().to_string(),
        metadata.ino().to_string(),
        format!("{}:{}", metadata.mtime(), metadata.mtime_nsec()),
        format!("{}:{}", metadata.ctime(), metadata.ctime_nsec()),
    ]
}

#[cfg(not(any(unix, windows)))]
fn precise_metadata_fields(metadata: &Metadata) -> [String; 4] {
    let (mtime, ctime) = metadata_times(metadata);
    [
        "unavailable".to_owned(),
        "unavailable".to_owned(),
        format!("{mtime:.6}"),
        format!("{ctime:.6}"),
    ]
}

fn metadata_version_matches(left: &Metadata, right: &Metadata) -> bool {
    left.is_file() == right.is_file()
        && left.is_dir() == right.is_dir()
        && left.len() == right.len()
        && precise_metadata_fields(left) == precise_metadata_fields(right)
}

#[cfg(windows)]
pub(crate) fn opened_file_identity(file: &File, kind: &str) -> Result<[String; 2], ApiError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    // SAFETY: BY_HANDLE_FILE_INFORMATION 是纯 C 数据结构，零值可作为 API
    // 输出缓冲；file 在调用期间保持打开，指针独占指向已分配的结构体。
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: as_raw_handle 返回 file 当前有效 HANDLE，输出指针及长度由
    // GetFileInformationByHandle 的固定签名约束。
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if succeeded == 0 {
        return Err(ApiError::new(
            "PRECISE_FILE_STATE_UNAVAILABLE",
            format!("无法获取{kind}的稳定文件标识"),
            503,
        ));
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok([
        information.dwVolumeSerialNumber.to_string(),
        file_index.to_string(),
    ])
}

#[cfg(unix)]
pub(crate) fn opened_file_identity(file: &File, kind: &str) -> Result<[String; 2], ApiError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata().map_err(|error| io_error(&error, kind))?;
    Ok([metadata.dev().to_string(), metadata.ino().to_string()])
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn opened_file_identity(_file: &File, kind: &str) -> Result<[String; 2], ApiError> {
    Err(ApiError::new(
        "PRECISE_FILE_STATE_UNAVAILABLE",
        format!("当前平台无法获取{kind}的稳定文件标识"),
        503,
    ))
}

fn probe_writable(
    store: &AuthorizationStore,
    webview: &str,
    path: &Path,
    expected_identity: &[String; 2],
) -> bool {
    let Ok(file) = OpenOptions::new().write(true).open(path) else {
        return false;
    };
    let Ok(opened) = opened_path(&file, path, "文稿") else {
        return false;
    };
    let Ok(identity) = opened_file_identity(&file, "文稿") else {
        return false;
    };
    opened == path
        && &identity == expected_identity
        && store
            .assert_canonical_authorized(webview, &opened, "文稿")
            .is_ok()
}

fn update_hash_field(hash: &mut Sha256, value: impl AsRef<[u8]>) {
    let value = value.as_ref();
    hash.update(value.len().to_string().as_bytes());
    hash.update(b":");
    hash.update(value);
    hash.update(b"\0");
}

pub(crate) fn file_revision(identity: &[String; 2], data: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"flux-reader-file-revision-v2\0");
    for value in identity {
        update_hash_field(&mut hash, value.as_bytes());
    }
    update_hash_field(&mut hash, data);
    format!("{:x}", hash.finalize())
}

fn ensure_type(
    metadata: &Metadata,
    expected: AuthorizationKind,
    kind: &str,
) -> Result<(), ApiError> {
    let matches = match expected {
        AuthorizationKind::File => metadata.is_file(),
        AuthorizationKind::Directory => metadata.is_dir(),
    };
    if matches {
        Ok(())
    } else {
        Err(ApiError::new(
            "INVALID_TARGET_TYPE",
            match expected {
                AuthorizationKind::File => format!("{kind}不是文件"),
                AuthorizationKind::Directory => format!("{kind}不是目录"),
            },
            400,
        ))
    }
}

impl AuthorizationStore {
    pub fn authorize_selection(
        &self,
        webview: &str,
        selected: &Path,
        kind: AuthorizationKind,
    ) -> Result<String, ApiError> {
        let canonical = canonicalize(selected, "所选路径")?;
        let metadata = fs::metadata(&canonical).map_err(|error| io_error(&error, "所选路径"))?;
        ensure_type(&metadata, kind, "所选路径")?;

        // 与 remove_webview 共用 commit gate：销毁已开始后，迟到的 dialog
        // 回调不能重新写入授权；反过来，已开始的授权会先完整落表再由销毁清除。
        let _commit_guard = self
            .commit_gate
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let closed_webviews = self
            .closed_webviews
            .read()
            .unwrap_or_else(|error| error.into_inner());
        if closed_webviews.contains(webview) {
            return Err(ApiError::new("WEBVIEW_CLOSED", "选择文件的窗口已关闭", 410));
        }

        // 与 remove_webview 固定使用 commit_gate -> closed_webviews -> roots 的锁顺序。
        // 持有关闭状态的读锁直到授权写入，保证销毁操作随后一定会清除它。
        let mut roots = self
            .roots
            .write()
            .unwrap_or_else(|error| error.into_inner());
        let values = roots.entry(webview.to_owned()).or_default();
        if !values
            .iter()
            .any(|root| root.canonical == canonical && root.kind == kind)
        {
            values.push(AuthorizedRoot {
                canonical: canonical.clone(),
                kind,
            });
        }
        Ok(path_to_locator(&canonical))
    }

    pub fn remove_webview(&self, webview: &str) {
        let _commit_guard = self
            .commit_gate
            .write()
            .unwrap_or_else(|error| error.into_inner());
        self.closed_webviews
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .insert(webview.to_owned());
        self.roots
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .remove(webview);
    }

    pub(crate) fn commit_authorization_gate(&self) -> Arc<RwLock<()>> {
        Arc::clone(&self.commit_gate)
    }

    fn roots_for(&self, webview: &str) -> Vec<AuthorizedRoot> {
        self.roots
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .get(webview)
            .cloned()
            .unwrap_or_default()
    }

    fn ensure_webview_open(&self, webview: &str) -> Result<(), ApiError> {
        if self
            .closed_webviews
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .contains(webview)
        {
            Err(ApiError::new("WEBVIEW_CLOSED", "发起请求的窗口已关闭", 410))
        } else {
            Ok(())
        }
    }

    fn assert_canonical_authorized(
        &self,
        webview: &str,
        canonical: &Path,
        kind: &str,
    ) -> Result<(), ApiError> {
        self.ensure_webview_open(webview)?;
        let roots = self.roots_for(webview);
        if roots.is_empty() {
            return Err(ApiError::new(
                "NO_AUTHORIZED_PATH",
                "尚未选择可访问的文件或文件夹",
                403,
            ));
        }
        let authorized = roots.iter().any(|root| match root.kind {
            AuthorizationKind::File => canonical == root.canonical,
            AuthorizationKind::Directory => canonical.starts_with(&root.canonical),
        });
        if authorized {
            Ok(())
        } else {
            Err(ApiError::new(
                "PATH_NOT_AUTHORIZED",
                format!("该{kind}未被授权访问"),
                403,
            ))
        }
    }

    fn resolve_target(
        &self,
        webview: &str,
        locator: &str,
        kind: &str,
        expected: AuthorizationKind,
    ) -> Result<AuthorizedTarget, ApiError> {
        let requested = parse_locator(locator, kind)?;
        let canonical = canonicalize(&requested, kind)?;
        // 先解析符号链接/重解析点，再做 Path 组件前缀比较，目录名相似不能越界。
        self.assert_canonical_authorized(webview, &canonical, kind)?;
        let metadata = fs::metadata(&canonical).map_err(|error| io_error(&error, kind))?;
        ensure_type(&metadata, expected, kind)?;
        Ok(AuthorizedTarget {
            canonical,
            metadata,
        })
    }

    fn assert_markdown_target(
        &self,
        webview: &str,
        locator: &str,
    ) -> Result<AuthorizedTarget, ApiError> {
        let requested = parse_locator(locator, "Markdown 文稿")?;
        if !is_markdown(&requested) {
            return Err(ApiError::new(
                "UNSUPPORTED_DOCUMENT_TYPE",
                "仅支持 .md / .markdown / .mdx 文件",
                400,
            ));
        }
        self.resolve_target(webview, locator, "Markdown 文稿", AuthorizationKind::File)
    }

    pub(crate) fn stable_markdown_snapshot(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<StableMarkdownSnapshot, ApiError> {
        cancellation.check()?;
        let requested = parse_locator(locator, "Markdown 文稿")?;
        if !is_markdown(&requested) {
            return Err(ApiError::new(
                "UNSUPPORTED_DOCUMENT_TYPE",
                "仅支持 .md / .markdown / .mdx 文件",
                400,
            ));
        }
        let target = self.assert_markdown_target(webview, locator)?;
        if target.metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(ApiError::new(
                "FILE_TOO_LARGE",
                format!(
                    "文件过大（{:.1} MiB），阅读器上限为 {} MiB",
                    target.metadata.len() as f64 / 1024.0 / 1024.0,
                    MAX_DOCUMENT_BYTES / 1024 / 1024
                ),
                413,
            ));
        }

        let mut file = File::open(&target.canonical).map_err(|error| io_error(&error, "文件"))?;
        let opened_canonical = opened_path(&file, &target.canonical, "文件")?;
        self.assert_canonical_authorized(webview, &opened_canonical, "文件")?;
        if opened_canonical != target.canonical {
            return Err(ApiError::new(
                "PATH_CHANGED_DURING_OPEN",
                "文件在打开期间移出授权范围",
                403,
            ));
        }
        let opened_metadata = file.metadata().map_err(|error| io_error(&error, "文件"))?;
        let opened_identity = opened_file_identity(&file, "文件")?;
        if !metadata_version_matches(&target.metadata, &opened_metadata) {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_READ",
                "文件在读取前发生变化",
                409,
            ));
        }

        let mut data = Vec::with_capacity(opened_metadata.len() as usize);
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            cancellation.check()?;
            let read = file
                .read(&mut chunk)
                .map_err(|error| io_error(&error, "文件"))?;
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() as u64 > MAX_DOCUMENT_BYTES {
                return Err(ApiError::new(
                    "FILE_TOO_LARGE",
                    "文件在读取期间超过 10 MiB 上限",
                    413,
                ));
            }
        }

        let final_handle_metadata = file.metadata().map_err(|error| io_error(&error, "文件"))?;
        let final_handle_identity = opened_file_identity(&file, "文件")?;
        let final_path_file =
            File::open(&target.canonical).map_err(|error| io_error(&error, "文件"))?;
        let final_path = opened_path(&final_path_file, &target.canonical, "文件")?;
        self.assert_canonical_authorized(webview, &final_path, "文件")?;
        let final_path_metadata = final_path_file
            .metadata()
            .map_err(|error| io_error(&error, "文件"))?;
        let final_path_identity = opened_file_identity(&final_path_file, "文件")?;
        if data.len() as u64 != opened_metadata.len()
            || opened_identity != final_handle_identity
            || opened_identity != final_path_identity
            || !metadata_version_matches(&opened_metadata, &final_handle_metadata)
            || !metadata_version_matches(&opened_metadata, &final_path_metadata)
            || final_path != target.canonical
        {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_READ",
                "文件在读取期间发生变化",
                409,
            ));
        }
        cancellation.check()?;
        let writable = probe_writable(self, webview, &target.canonical, &opened_identity);
        let revision = file_revision(&opened_identity, &data);
        Ok(StableMarkdownSnapshot {
            canonical: target.canonical,
            data,
            metadata: final_path_metadata,
            identity: opened_identity,
            revision,
            writable,
        })
    }

    pub(crate) fn stable_markdown_state(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<StableMarkdownState, ApiError> {
        cancellation.check()?;
        let requested = parse_locator(locator, "Markdown 文稿")?;
        if !is_markdown(&requested) {
            return Err(ApiError::new(
                "UNSUPPORTED_DOCUMENT_TYPE",
                "仅支持 .md / .markdown / .mdx 文件",
                400,
            ));
        }
        let target = self.assert_markdown_target(webview, locator)?;
        let file = File::open(&target.canonical).map_err(|error| io_error(&error, "文件"))?;
        let opened_canonical = opened_path(&file, &target.canonical, "文件")?;
        self.assert_canonical_authorized(webview, &opened_canonical, "文件")?;
        if opened_canonical != target.canonical {
            return Err(ApiError::new(
                "PATH_CHANGED_DURING_OPEN",
                "文件在打开期间移出授权范围",
                403,
            ));
        }
        let opened_metadata = file.metadata().map_err(|error| io_error(&error, "文件"))?;
        let opened_identity = opened_file_identity(&file, "文件")?;
        if !metadata_version_matches(&target.metadata, &opened_metadata) {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_STATE_READ",
                "文件在读取元数据期间发生变化",
                409,
            ));
        }
        let final_path_file =
            File::open(&target.canonical).map_err(|error| io_error(&error, "文件"))?;
        let final_path = opened_path(&final_path_file, &target.canonical, "文件")?;
        self.assert_canonical_authorized(webview, &final_path, "文件")?;
        let final_metadata = final_path_file
            .metadata()
            .map_err(|error| io_error(&error, "文件"))?;
        let final_identity = opened_file_identity(&final_path_file, "文件")?;
        if opened_identity != final_identity
            || !metadata_version_matches(&opened_metadata, &final_metadata)
            || final_path != target.canonical
        {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_STATE_READ",
                "文件在读取元数据期间发生变化",
                409,
            ));
        }
        cancellation.check()?;
        let writable = probe_writable(self, webview, &target.canonical, &opened_identity);
        // file-state 不向前端返回正文，但仍流式散列任意大小目标；这样恢复 CAS 对超过
        // 10 MiB 的当前版本也能识别“同大小、同时间戳”的外部改写，而普通读取上限不变。
        let mut state_file = file;
        let mut content_hash = Sha256::new();
        let mut content_bytes = 0_u64;
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            cancellation.check()?;
            let read = state_file
                .read(&mut chunk)
                .map_err(|error| io_error(&error, "文件"))?;
            if read == 0 {
                break;
            }
            content_bytes = content_bytes.saturating_add(read as u64);
            content_hash.update(&chunk[..read]);
        }
        let content_sha256 = format!("{:x}", content_hash.finalize());
        let revision = if opened_metadata.len() <= MAX_DOCUMENT_BYTES {
            // 保持与 GET /file 完全相同的 token，避免轮询误判。
            let snapshot = self.stable_markdown_snapshot(webview, locator, cancellation)?;
            if format!("{:x}", Sha256::digest(&snapshot.data)) != content_sha256 {
                return Err(ApiError::new(
                    "FILE_CHANGED_DURING_STATE_READ",
                    "文件在读取元数据期间发生变化",
                    409,
                ));
            }
            snapshot.revision
        } else {
            let mut hash = Sha256::new();
            hash.update(b"flux-reader-file-state-revision-v2\0");
            for value in &opened_identity {
                update_hash_field(&mut hash, value.as_bytes());
            }
            update_hash_field(&mut hash, content_sha256.as_bytes());
            format!("{:x}", hash.finalize())
        };
        // stable_markdown_snapshot 可能在 metadata 双检之后完成；重新核验 pathname，
        // 防止返回一个已不再属于当前目标的旧 token。
        let verified_file =
            File::open(&target.canonical).map_err(|error| io_error(&error, "文件"))?;
        let verified_path = opened_path(&verified_file, &target.canonical, "文件")?;
        self.assert_canonical_authorized(webview, &verified_path, "文件")?;
        let verified_metadata = verified_file
            .metadata()
            .map_err(|error| io_error(&error, "文件"))?;
        let verified_identity = opened_file_identity(&verified_file, "文件")?;
        if verified_path != target.canonical
            || verified_identity != opened_identity
            || content_bytes != verified_metadata.len()
            || !metadata_version_matches(&verified_metadata, &final_metadata)
        {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_STATE_READ",
                "文件在读取元数据期间发生变化",
                409,
            ));
        }
        Ok(StableMarkdownState {
            canonical: target.canonical,
            metadata: verified_metadata,
            identity: opened_identity,
            revision,
            writable,
            content_sha256,
        })
    }

    pub(crate) fn stable_recovery_snapshot(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<StableMarkdownSnapshot, ApiError> {
        let state = self.stable_markdown_state(webview, locator, cancellation)?;
        if state.metadata.len() > MAX_RECOVERY_BASELINE_BYTES {
            return Err(ApiError::new(
                "RECOVERY_BASELINE_TOO_LARGE",
                "当前文稿超过 16 MiB 恢复基线保护上限",
                413,
            ));
        }
        // stable_markdown_state 的 token 已在第一次观察后生成；恢复写入必须在读取
        // baseline 后仍与它一致，避免大文件 metadata-CAS 与实际读取之间的窗口。
        let observed_revision = state.revision.clone();
        let mut file = File::open(&state.canonical).map_err(|error| io_error(&error, "文稿"))?;
        let opened_canonical = opened_path(&file, &state.canonical, "文稿")?;
        self.assert_canonical_authorized(webview, &opened_canonical, "文稿")?;
        let opened_metadata = file.metadata().map_err(|error| io_error(&error, "文稿"))?;
        let opened_identity = opened_file_identity(&file, "文稿")?;
        if opened_canonical != state.canonical
            || opened_identity != state.identity
            || !metadata_version_matches(&opened_metadata, &state.metadata)
        {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_READ",
                "文稿在建立恢复基线前发生变化",
                409,
            ));
        }
        let mut data = Vec::with_capacity(opened_metadata.len() as usize);
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            cancellation.check()?;
            let read = file
                .read(&mut chunk)
                .map_err(|error| io_error(&error, "文稿"))?;
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() as u64 > MAX_RECOVERY_BASELINE_BYTES {
                return Err(ApiError::new(
                    "RECOVERY_BASELINE_TOO_LARGE",
                    "文稿在读取期间超过 16 MiB 恢复基线保护上限",
                    413,
                ));
            }
        }
        let final_metadata = file.metadata().map_err(|error| io_error(&error, "文稿"))?;
        let final_identity = opened_file_identity(&file, "文稿")?;
        if data.len() as u64 != opened_metadata.len()
            || final_identity != opened_identity
            || !metadata_version_matches(&final_metadata, &opened_metadata)
        {
            return Err(ApiError::new(
                "FILE_CHANGED_DURING_READ",
                "文稿在建立恢复基线期间发生变化",
                409,
            ));
        }
        let revision = match format!("{:x}", Sha256::digest(&data)) {
            current_hash if current_hash == state.content_sha256 => {
                let revision = file_revision(&opened_identity, &data);
                if state.metadata.len() <= MAX_DOCUMENT_BYTES && revision != observed_revision {
                    return Err(ApiError::new(
                        "FILE_CHANGED_DURING_READ",
                        "文稿在建立恢复基线期间发生变化",
                        409,
                    ));
                }
                if state.metadata.len() > MAX_DOCUMENT_BYTES {
                    observed_revision
                } else {
                    revision
                }
            }
            _ => {
                return Err(ApiError::new(
                    "FILE_CHANGED_DURING_READ",
                    "文稿在建立恢复基线期间发生变化",
                    409,
                ));
            }
        };
        Ok(StableMarkdownSnapshot {
            canonical: state.canonical,
            data,
            metadata: final_metadata,
            identity: opened_identity,
            revision,
            writable: state.writable,
        })
    }

    pub(crate) fn assert_safe_save_locator(&self, locator: &str) -> Result<(), ApiError> {
        let requested = parse_locator(locator, "Markdown 文稿")?;
        if !is_markdown(&requested) {
            return Err(ApiError::new(
                "UNSUPPORTED_DOCUMENT_TYPE",
                "仅支持 .md / .markdown / .mdx 文件",
                400,
            ));
        }
        let link_metadata =
            fs::symlink_metadata(&requested).map_err(|error| io_error(&error, "Markdown 文稿"))?;
        if is_reparse_point(&link_metadata) {
            return Err(ApiError::new(
                "SYMLINK_SAVE_DENIED",
                "为避免保存到重解析目标，不支持直接编辑符号链接文稿",
                409,
            ));
        }
        Ok(())
    }

    pub(crate) fn new_markdown_target(
        &self,
        webview: &str,
        locator: &str,
    ) -> Result<PathBuf, ApiError> {
        self.ensure_webview_open(webview)?;
        let requested = parse_locator(locator, "Markdown 文稿")?;
        if !is_markdown(&requested) {
            return Err(ApiError::new(
                "UNSUPPORTED_DOCUMENT_TYPE",
                "仅支持 .md / .markdown / .mdx 文件",
                400,
            ));
        }
        let file_name = requested
            .file_name()
            .ok_or_else(|| ApiError::new("INVALID_PATH", "Markdown 文稿路径缺少文件名", 400))?;
        let parent = requested
            .parent()
            .ok_or_else(|| ApiError::new("INVALID_PATH", "Markdown 文稿路径缺少父目录", 400))?;
        let canonical_parent = canonicalize(parent, "父目录")?;
        self.assert_canonical_authorized(webview, &canonical_parent, "父目录")?;
        let metadata =
            fs::metadata(&canonical_parent).map_err(|error| io_error(&error, "父目录"))?;
        ensure_type(&metadata, AuthorizationKind::Directory, "父目录")?;
        let candidate = canonical_parent.join(file_name);
        self.assert_canonical_authorized(webview, &candidate, "Markdown 文稿")?;
        Ok(candidate)
    }

    pub fn read_markdown(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let snapshot = self.stable_markdown_snapshot(webview, locator, cancellation)?;
        let content = String::from_utf8(snapshot.data)
            .map_err(|_| ApiError::new("INVALID_UTF8", "文件不是有效的 UTF-8 文本", 422))?;
        let (mtime, ctime) = metadata_times(&snapshot.metadata);
        Ok(json!({
            "content": content,
            "actualPath": path_to_locator(&snapshot.canonical),
            "size": snapshot.metadata.len(),
            "mtime": mtime,
            "ctime": ctime,
            "revision": snapshot.revision,
            "writable": snapshot.writable
        }))
    }

    pub fn markdown_state(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let state = self.stable_markdown_state(webview, locator, cancellation)?;
        let (mtime, ctime) = metadata_times(&state.metadata);
        Ok(json!({
            "actualPath": path_to_locator(&state.canonical),
            "size": state.metadata.len(),
            "mtime": mtime,
            "ctime": ctime,
            "revision": state.revision,
            "writable": state.writable
        }))
    }

    fn list_entries(
        &self,
        webview: &str,
        directory_locator: &str,
        include_images: bool,
        cancellation: &CancellationToken,
    ) -> Result<(PathBuf, Vec<ListedEntry>), ApiError> {
        cancellation.check()?;
        let directory = self.resolve_target(
            webview,
            directory_locator,
            "目录",
            AuthorizationKind::Directory,
        )?;
        let iterator =
            fs::read_dir(&directory.canonical).map_err(|error| io_error(&error, "目录"))?;
        let mut raw_count = 0_usize;
        let mut entries = Vec::new();

        for item in iterator {
            cancellation.check()?;
            raw_count += 1;
            if raw_count > MAX_DIRECTORY_ENTRIES {
                return Err(ApiError::new(
                    "DIRECTORY_SCAN_LIMIT",
                    format!("单个目录条目超过 {MAX_DIRECTORY_ENTRIES} 个"),
                    413,
                ));
            }
            let item = match item {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
                Err(error) => return Err(io_error(&error, "目录子项")),
            };
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || is_internal_sidecar_name(&name) {
                continue;
            }
            let file_type = match item.file_type() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
                Err(error) => return Err(io_error(&error, "目录子项")),
            };
            let candidate_path = item.path();
            // Windows junction 等重解析点不一定由 is_symlink 覆盖；symlink_metadata
            // 的 FILE_ATTRIBUTE_REPARSE_POINT 才是拒绝遍历的最终依据。
            let link_metadata = match fs::symlink_metadata(&candidate_path) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
                Err(error) => return Err(io_error(&error, "目录子项")),
            };
            if is_reparse_point(&link_metadata) {
                continue;
            }
            let is_directory = file_type.is_dir();
            let is_markdown_file = file_type.is_file() && is_markdown(&candidate_path);
            let image_format = file_type
                .is_file()
                .then(|| image_mime_type(&candidate_path))
                .flatten();
            if !is_directory && !is_markdown_file && !(include_images && image_format.is_some()) {
                continue;
            }
            let canonical = match canonicalize(&candidate_path, "目录子项") {
                Ok(value) => value,
                Err(error) if matches!(error.status, 403 | 404) => continue,
                Err(error) => return Err(error),
            };
            self.assert_canonical_authorized(webview, &canonical, "目录子项")?;
            if canonical.parent() != Some(directory.canonical.as_path()) {
                return Err(ApiError::new(
                    "CHILD_PATH_CHANGED",
                    "目录子项已不再属于当前父目录",
                    403,
                ));
            }
            let metadata =
                fs::metadata(&canonical).map_err(|error| io_error(&error, "目录子项"))?;
            if (is_directory && !metadata.is_dir()) || (!is_directory && !metadata.is_file()) {
                return Err(ApiError::new(
                    "CHILD_TYPE_CHANGED",
                    "目录子项类型已发生变化",
                    403,
                ));
            }
            let (mtime, ctime) = metadata_times(&metadata);
            entries.push(ListedEntry {
                public: DirectoryEntry {
                    name,
                    path: path_to_locator(&canonical),
                    kind: if is_directory { "dir" } else { "file" }.to_owned(),
                    format: if is_directory {
                        None
                    } else if is_markdown_file {
                        Some("markdown".to_owned())
                    } else {
                        Some("image".to_owned())
                    },
                    size: metadata.len(),
                    mtime,
                    ctime,
                },
                canonical,
            });
        }

        let final_directory = canonicalize(&directory.canonical, "目录")?;
        if final_directory != directory.canonical {
            return Err(ApiError::new(
                "PATH_CHANGED_DURING_AUTHORIZATION",
                "目录在读取期间发生变化",
                409,
            ));
        }
        entries.sort_by(|left, right| {
            let left_directory = left.public.kind == "dir";
            let right_directory = right.public.kind == "dir";
            right_directory
                .cmp(&left_directory)
                .then_with(|| {
                    left.public
                        .name
                        .to_lowercase()
                        .cmp(&right.public.name.to_lowercase())
                })
                .then_with(|| left.public.name.cmp(&right.public.name))
        });
        Ok((directory.canonical, entries))
    }

    pub fn list_directory(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let (actual_path, entries) = self.list_entries(webview, locator, false, cancellation)?;
        Ok(json!({
            "actualPath": path_to_locator(&actual_path),
            "entries": entries.into_iter().map(|entry| entry.public).collect::<Vec<_>>()
        }))
    }

    fn selected_workspaces(
        &self,
        webview: &str,
        locators: &[String],
        cancellation: &CancellationToken,
    ) -> Result<Vec<Workspace>, ApiError> {
        if locators.is_empty() || locators.len() > MAX_SELECTED_WORKSPACES {
            return Err(ApiError::new(
                "INVALID_WORKSPACE_COUNT",
                format!("每次最多选择 {MAX_SELECTED_WORKSPACES} 个工作区"),
                400,
            ));
        }
        let mut by_path = HashMap::new();
        for locator in locators {
            cancellation.check()?;
            let target =
                self.resolve_target(webview, locator, "工作区", AuthorizationKind::Directory)?;
            by_path
                .entry(target.canonical.clone())
                .or_insert(Workspace {
                    requested_path: locator.clone(),
                    canonical: target.canonical,
                    metadata: target.metadata,
                });
        }
        let mut workspaces = by_path.into_values().collect::<Vec<_>>();
        workspaces.sort_by(|left, right| {
            right
                .canonical
                .components()
                .count()
                .cmp(&left.canonical.components().count())
                .then_with(|| left.canonical.cmp(&right.canonical))
        });
        Ok(workspaces)
    }

    fn relative_path(root: &Path, target: &Path) -> Result<String, ApiError> {
        let relative = target.strip_prefix(root).map_err(|_| {
            ApiError::new(
                "WORKSPACE_CHANGED_DURING_SCAN",
                "工作区在扫描期间发生变化",
                409,
            )
        })?;
        Ok(relative
            .components()
            .map(|item| item.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"))
    }

    fn collect_tree(
        &self,
        webview: &str,
        workspace: &Workspace,
        options: TreeScanOptions<'_>,
        cancellation: &CancellationToken,
    ) -> Result<TreeScan, ApiError> {
        let mut records = Vec::new();
        let mut queue = VecDeque::from([(workspace.canonical.clone(), 0_usize)]);
        let excluded = options
            .excluded_roots
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let mut visited = HashSet::from([workspace.canonical.clone()]);
        let mut truncated = false;

        while let Some((directory, depth)) = queue.pop_front() {
            cancellation.check()?;
            let directory_locator = path_to_locator(&directory);
            let (_, entries) = self.list_entries(
                webview,
                &directory_locator,
                options.include_images,
                cancellation,
            )?;
            for entry in entries {
                cancellation.check()?;
                if entry.public.kind == "dir" && excluded.contains(&entry.canonical) {
                    continue;
                }
                if *options.budget == 0 {
                    if options.truncate_on_limit {
                        truncated = true;
                        break;
                    }
                    return Err(ApiError::new(
                        "WORKSPACE_SCAN_LIMIT",
                        format!("工作区可见条目超过 {MAX_TREE_ENTRIES} 个"),
                        413,
                    ));
                }
                *options.budget -= 1;
                let relative_path = Self::relative_path(&workspace.canonical, &entry.canonical)?;
                let is_directory = entry.public.kind == "dir";
                if is_directory && !visited.insert(entry.canonical.clone()) {
                    continue;
                }
                records.push(TreeRecord {
                    entry: entry.clone(),
                    relative_path,
                });
                if is_directory && depth + 1 >= MAX_TREE_DEPTH {
                    if options.truncate_on_limit {
                        truncated = true;
                        break;
                    }
                    return Err(ApiError::new(
                        "WORKSPACE_SCAN_LIMIT",
                        format!("工作区目录深度超过 {MAX_TREE_DEPTH} 层"),
                        413,
                    ));
                }
                if is_directory && depth + 1 < MAX_TREE_DEPTH {
                    queue.push_back((entry.canonical.clone(), depth + 1));
                }
            }
            if truncated {
                break;
            }
        }

        cancellation.check()?;
        let current = self.resolve_target(
            webview,
            &workspace.requested_path,
            "工作区",
            AuthorizationKind::Directory,
        )?;
        if current.canonical != workspace.canonical {
            return Err(ApiError::new(
                "WORKSPACE_CHANGED_DURING_SCAN",
                "工作区在扫描期间被替换",
                409,
            ));
        }
        Ok(TreeScan { records, truncated })
    }

    pub fn search_markdown(
        &self,
        webview: &str,
        workspace_paths: &[String],
        query: &str,
        requested_limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        cancellation.check()?;
        let needle = query.trim();
        if needle.is_empty() {
            return Ok(json!({ "results": [], "scannedFiles": 0, "truncated": false }));
        }
        if needle.encode_utf16().count() > MAX_SEARCH_QUERY_LENGTH {
            return Err(ApiError::new(
                "SEARCH_QUERY_TOO_LONG",
                format!("搜索词不能超过 {MAX_SEARCH_QUERY_LENGTH} 个字符"),
                400,
            ));
        }
        let limit = requested_limit.clamp(1, MAX_SEARCH_RESULTS);
        let workspaces = self.selected_workspaces(webview, workspace_paths, cancellation)?;
        let mut budget = MAX_TREE_ENTRIES;
        let mut candidates = Vec::new();
        let mut seen_files = HashSet::new();
        let mut truncated = false;

        for (index, workspace) in workspaces.iter().enumerate() {
            cancellation.check()?;
            if budget == 0 {
                truncated = true;
                break;
            }
            let excluded = workspaces[..index]
                .iter()
                .filter(|other| other.canonical.starts_with(&workspace.canonical))
                .map(|other| other.canonical.clone())
                .collect::<Vec<_>>();
            let tree = self.collect_tree(
                webview,
                workspace,
                TreeScanOptions {
                    budget: &mut budget,
                    truncate_on_limit: true,
                    excluded_roots: &excluded,
                    include_images: false,
                },
                cancellation,
            )?;
            truncated |= tree.truncated;
            for record in tree.records {
                if record.entry.public.format.as_deref() != Some("markdown")
                    || !seen_files.insert(record.entry.canonical.clone())
                {
                    continue;
                }
                candidates.push((record, workspace.requested_path.clone()));
            }
        }

        candidates.sort_by(|(left, _), (right, _)| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let scanned_files = candidates.len();
        let folded_query = fold_search_text(needle);
        let mut file_name_matches = Vec::new();
        let mut content_candidates = Vec::new();
        for (record, workspace_path) in candidates {
            cancellation.check()?;
            if fold_search_text(&record.relative_path).contains(&folded_query) {
                file_name_matches.push((record, workspace_path));
            } else if record.entry.public.size <= MAX_DOCUMENT_BYTES {
                content_candidates.push((record, workspace_path));
            }
        }

        let mut results = Vec::new();
        let mut file_name_matches_checked = 0_usize;
        let has_content_candidates = !content_candidates.is_empty();
        for (record, workspace_path) in file_name_matches {
            cancellation.check()?;
            if results.len() >= limit {
                truncated = true;
                break;
            }
            match self.assert_markdown_target(webview, &record.entry.public.path) {
                Ok(_) => {}
                Err(error) if error.status == 404 => continue,
                Err(error) => return Err(error),
            }
            file_name_matches_checked += 1;
            results.push(json!({
                "path": record.entry.public.path,
                "name": record.entry.public.name,
                "displayPath": record.relative_path,
                "snippet": record.relative_path,
                "matchKind": "fileName",
                "workspacePath": workspace_path
            }));
        }

        let mut content_files_read = 0_usize;
        let mut content_bytes_scheduled = 0_u64;
        let mut content_bytes_read = 0_u64;
        if results.len() < limit {
            for (record, workspace_path) in content_candidates {
                cancellation.check()?;
                if results.len() >= limit {
                    truncated = true;
                    break;
                }
                let size = record.entry.public.size;
                if content_files_read >= MAX_SEARCH_CONTENT_FILES
                    || content_bytes_scheduled.saturating_add(size) > MAX_SEARCH_CONTENT_BYTES
                    || content_bytes_read.saturating_add(size) > MAX_SEARCH_CONTENT_BYTES
                {
                    truncated = true;
                    break;
                }
                content_bytes_scheduled += size;
                let document =
                    match self.read_markdown(webview, &record.entry.public.path, cancellation) {
                        Ok(value) => value,
                        Err(error)
                            if error.status == 404
                                || error.status == 413
                                || error.error == "INVALID_UTF8" =>
                        {
                            continue
                        }
                        Err(error) => return Err(error),
                    };
                content_files_read += 1;
                let read_size = document.get("size").and_then(Value::as_u64).unwrap_or(0);
                content_bytes_read = content_bytes_read.saturating_add(read_size);
                if content_bytes_read > MAX_SEARCH_CONTENT_BYTES {
                    truncated = true;
                    break;
                }
                let content = document
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let Some(snippet) = matching_snippet(content, &folded_query) else {
                    continue;
                };
                results.push(json!({
                    "path": record.entry.public.path,
                    "name": record.entry.public.name,
                    "displayPath": record.relative_path,
                    "snippet": snippet,
                    "matchKind": "content",
                    "workspacePath": workspace_path
                }));
            }
        } else if has_content_candidates {
            truncated = true;
        }

        cancellation.check()?;
        Ok(json!({
            "results": results,
            "scannedFiles": scanned_files,
            "fileNameMatchesChecked": file_name_matches_checked,
            "contentFilesRead": content_files_read,
            "contentBytesScheduled": content_bytes_scheduled,
            "contentBytesRead": content_bytes_read,
            "truncated": truncated
        }))
    }

    pub fn workspace_state(
        &self,
        webview: &str,
        locator: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        cancellation.check()?;
        let workspaces = self.selected_workspaces(webview, &[locator.to_owned()], cancellation)?;
        let workspace = &workspaces[0];
        let mut budget = MAX_TREE_ENTRIES;
        let tree = self.collect_tree(
            webview,
            workspace,
            TreeScanOptions {
                budget: &mut budget,
                truncate_on_limit: false,
                excluded_roots: &[],
                include_images: true,
            },
            cancellation,
        )?;
        let mut records = tree
            .records
            .into_iter()
            .map(|record| {
                json!({
                    "relativePath": record.relative_path,
                    "type": record.entry.public.kind,
                    "format": record.entry.public.format,
                    "size": record.entry.public.size,
                    "mtime": record.entry.public.mtime,
                    "ctime": record.entry.public.ctime
                })
            })
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            left.get("relativePath")
                .and_then(Value::as_str)
                .cmp(&right.get("relativePath").and_then(Value::as_str))
        });
        let (root_mtime, root_ctime) = metadata_times(&workspace.metadata);
        let revision_source = json!({
            "root": {
                "type": "dir",
                "size": workspace.metadata.len(),
                "mtime": root_mtime,
                "ctime": root_ctime
            },
            "records": records
        });
        let revision = format!(
            "{:x}",
            Sha256::digest(revision_source.to_string().as_bytes())
        );
        let records = revision_source
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let file_count = records
            .iter()
            .filter(|record| record.get("format").and_then(Value::as_str) == Some("markdown"))
            .count();
        let image_count = records
            .iter()
            .filter(|record| record.get("format").and_then(Value::as_str) == Some("image"))
            .count();
        let directory_count = records
            .iter()
            .filter(|record| record.get("type").and_then(Value::as_str) == Some("dir"))
            .count();
        Ok(json!({
            "path": &workspace.requested_path,
            "actualPath": path_to_locator(&workspace.canonical),
            "revision": revision,
            "fileCount": file_count,
            "imageCount": image_count,
            "directoryCount": directory_count,
            "generatedAt": milliseconds(Ok(SystemTime::now()))
        }))
    }

    fn read_image(
        &self,
        webview: &str,
        root: &Path,
        candidate: &Path,
        require_direct_authorization: bool,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<u8>, &'static str), ApiError> {
        cancellation.check()?;
        self.ensure_webview_open(webview)?;
        let canonical_root = canonicalize(root, "资源工作区")?;
        let root_metadata =
            fs::metadata(&canonical_root).map_err(|error| io_error(&error, "资源工作区"))?;
        ensure_type(&root_metadata, AuthorizationKind::Directory, "资源工作区")?;
        let canonical_candidate = canonicalize(candidate, "图片")?;
        if !path_is_strictly_within(&canonical_root, &canonical_candidate) {
            return Err(ApiError::new(
                "RESOURCE_OUTSIDE_WORKSPACE",
                "图片真实路径超出资源工作区",
                403,
            ));
        }
        if require_direct_authorization {
            self.assert_canonical_authorized(webview, &canonical_candidate, "图片")?;
        }
        let target_metadata =
            fs::metadata(&canonical_candidate).map_err(|error| io_error(&error, "图片"))?;
        ensure_type(&target_metadata, AuthorizationKind::File, "图片")?;
        let Some(mime_type) = image_mime_type(&canonical_candidate) else {
            return Err(ApiError::new(
                "UNSUPPORTED_IMAGE_TYPE",
                "图片格式不受支持",
                415,
            ));
        };
        if target_metadata.len() > MAX_IMAGE_BYTES {
            return Err(ApiError::new(
                "IMAGE_TOO_LARGE",
                "图片超过 25 MiB 读取上限",
                413,
            ));
        }
        let mut file =
            File::open(&canonical_candidate).map_err(|error| io_error(&error, "图片"))?;
        let opened_canonical = opened_path(&file, &canonical_candidate, "图片")?;
        if require_direct_authorization {
            self.assert_canonical_authorized(webview, &opened_canonical, "图片")?;
        }
        if opened_canonical != canonical_candidate
            || !path_is_strictly_within(&canonical_root, &opened_canonical)
        {
            return Err(ApiError::new(
                "PATH_CHANGED_DURING_OPEN",
                "图片在打开期间移出授权范围",
                403,
            ));
        }
        let opened_metadata = file.metadata().map_err(|error| io_error(&error, "图片"))?;
        let opened_identity = opened_file_identity(&file, "图片")?;
        if !metadata_version_matches(&target_metadata, &opened_metadata) {
            return Err(ApiError::new(
                "IMAGE_CHANGED_DURING_READ",
                "图片在读取前发生变化",
                409,
            ));
        }

        let mut data = Vec::with_capacity(opened_metadata.len() as usize);
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            cancellation.check()?;
            let read = file
                .read(&mut chunk)
                .map_err(|error| io_error(&error, "图片"))?;
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() as u64 > MAX_IMAGE_BYTES {
                return Err(ApiError::new(
                    "IMAGE_TOO_LARGE",
                    "图片超过 25 MiB 读取上限",
                    413,
                ));
            }
        }
        let final_handle_metadata = file.metadata().map_err(|error| io_error(&error, "图片"))?;
        let final_handle_identity = opened_file_identity(&file, "图片")?;
        let final_path_file =
            File::open(&canonical_candidate).map_err(|error| io_error(&error, "图片"))?;
        let final_path = opened_path(&final_path_file, &canonical_candidate, "图片")?;
        let final_path_metadata = final_path_file
            .metadata()
            .map_err(|error| io_error(&error, "图片"))?;
        let final_path_identity = opened_file_identity(&final_path_file, "图片")?;
        let final_root = canonicalize(&canonical_root, "资源工作区")?;
        let final_root_metadata =
            fs::metadata(&final_root).map_err(|error| io_error(&error, "资源工作区"))?;
        if require_direct_authorization {
            self.assert_canonical_authorized(webview, &final_path, "图片")?;
        }
        if data.len() as u64 != opened_metadata.len()
            || opened_identity != final_handle_identity
            || opened_identity != final_path_identity
            || !metadata_version_matches(&opened_metadata, &final_handle_metadata)
            || !metadata_version_matches(&opened_metadata, &final_path_metadata)
            || final_path != canonical_candidate
            || !path_is_strictly_within(&canonical_root, &final_path)
            || final_root != canonical_root
            || !metadata_version_matches(&root_metadata, &final_root_metadata)
        {
            return Err(ApiError::new(
                "IMAGE_CHANGED_DURING_READ",
                "图片在读取期间发生变化",
                409,
            ));
        }
        if !has_image_signature(&data, mime_type) {
            return Err(ApiError::new(
                "INVALID_IMAGE_CONTENT",
                "文件内容不是受支持的图片",
                415,
            ));
        }
        Ok((data, mime_type))
    }

    /**
     * Markdown 资源协议的专用边界。
     *
     * 单文件授权只额外开放同目录图片，不会让 sibling Markdown 进入普通文件 API；
     * 显式 workspace 则必须自身已获目录授权，且文稿真实路径位于其中。
     */
    pub fn read_local_image(
        &self,
        webview: &str,
        document_locator: &str,
        raw_source: &str,
        workspace_locator: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<u8>, &'static str), ApiError> {
        cancellation.check()?;
        let document = self.assert_markdown_target(webview, document_locator)?;
        let document_parent = document.canonical.parent().ok_or_else(|| {
            ApiError::new("INVALID_RESOURCE_PATH", "Markdown 文稿缺少父目录", 400)
        })?;
        let root = if let Some(locator) = workspace_locator.filter(|value| !value.is_empty()) {
            let workspace =
                self.resolve_target(webview, locator, "资源工作区", AuthorizationKind::Directory)?;
            if !path_is_strictly_within(&workspace.canonical, &document.canonical) {
                return Err(ApiError::new(
                    "DOCUMENT_OUTSIDE_WORKSPACE",
                    "Markdown 文稿不在指定资源工作区内",
                    403,
                ));
            }
            workspace.canonical
        } else {
            canonicalize(document_parent, "资源工作区")?
        };
        let (relative, root_relative) = parse_local_resource_source(raw_source)?;
        let base = if root_relative {
            root.as_path()
        } else {
            document_parent
        };
        if base != root && !path_is_strictly_within(&root, base) {
            return Err(ApiError::new(
                "DOCUMENT_OUTSIDE_WORKSPACE",
                "Markdown 文稿不在指定资源工作区内",
                403,
            ));
        }
        let lexical_candidate = lexical_resource_candidate(base, &root, &relative)?;
        self.read_image(webview, &root, &lexical_candidate, false, cancellation)
    }
}

fn fold_search_text(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .collect()
}

fn truncate_characters(value: &str, maximum: usize) -> String {
    let mut characters = value.chars();
    let prefix = characters.by_ref().take(maximum).collect::<String>();
    if characters.next().is_some() {
        let shortened = prefix
            .chars()
            .take(maximum.saturating_sub(1))
            .collect::<String>();
        format!("{shortened}…")
    } else {
        prefix
    }
}

fn matching_snippet(content: &str, folded_query: &str) -> Option<String> {
    content.lines().find_map(|line| {
        if !fold_search_text(line).contains(folded_query) {
            return None;
        }
        let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
        Some(truncate_characters(&compact, 180))
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::tempdir;

    use super::*;
    use crate::request_registry::RequestRegistry;

    fn token() -> (crate::request_registry::RequestLease, CancellationToken) {
        let registry = RequestRegistry::default();
        let lease = registry.register("main", "test-request").unwrap();
        let token = lease.token();
        (lease, token)
    }

    #[test]
    fn selected_file_does_not_authorize_its_siblings() {
        let directory = tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        let sibling = directory.path().join("sibling.md");
        fs::write(&selected, "selected").unwrap();
        fs::write(&sibling, "sibling").unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", &selected, AuthorizationKind::File)
            .unwrap();
        let (_lease, cancellation) = token();

        assert!(store
            .read_markdown("main", &path_to_locator(&selected), &cancellation)
            .is_ok());
        let error = store
            .read_markdown("main", &path_to_locator(&sibling), &cancellation)
            .unwrap_err();
        assert_eq!(error.error, "PATH_NOT_AUTHORIZED");
    }

    #[test]
    fn authorization_is_scoped_to_webview_and_revoked_on_destroy() {
        let directory = tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        fs::write(&selected, "selected").unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", &selected, AuthorizationKind::File)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_markdown("secondary", &path_to_locator(&selected), &cancellation)
                .unwrap_err()
                .error,
            "NO_AUTHORIZED_PATH"
        );
        store.remove_webview("main");
        assert_eq!(
            store
                .read_markdown("main", &path_to_locator(&selected), &cancellation)
                .unwrap_err()
                .error,
            "WEBVIEW_CLOSED"
        );
        assert_eq!(
            store
                .authorize_selection("main", &selected, AuthorizationKind::File)
                .unwrap_err()
                .error,
            "WEBVIEW_CLOSED"
        );
    }

    #[test]
    fn late_authorization_cannot_reopen_a_destroyed_webview() {
        let directory = tempdir().unwrap();
        let selected = directory.path().join("selected.md");
        fs::write(&selected, "selected").unwrap();
        let store = AuthorizationStore::default();
        let gate = store.commit_authorization_gate();
        let gate_guard = gate.read().unwrap();
        let store_for_destroy = store.clone();
        let destroy = std::thread::spawn(move || store_for_destroy.remove_webview("main"));
        drop(gate_guard);
        destroy.join().unwrap();

        assert_eq!(
            store
                .authorize_selection("main", &selected, AuthorizationKind::File)
                .unwrap_err()
                .error,
            "WEBVIEW_CLOSED"
        );
    }

    #[test]
    fn lexical_parent_traversal_is_rejected_before_authorization() {
        let selected = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", selected.path(), AuthorizationKind::Directory)
            .unwrap();
        let traversal = selected
            .path()
            .join("child")
            .join("..")
            .join(outside.path().file_name().unwrap());
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .list_directory("main", &path_to_locator(&traversal), &cancellation)
                .unwrap_err()
                .error,
            "INVALID_PATH"
        );
    }

    #[test]
    fn directory_listing_and_search_keep_the_fnos_public_shape() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("子目录")).unwrap();
        fs::write(directory.path().join("hello.md"), "# 标题\nneedle line").unwrap();
        fs::write(directory.path().join("ignored.txt"), "needle").unwrap();
        fs::write(directory.path().join(".hidden.md"), "needle").unwrap();
        let store = AuthorizationStore::default();
        let root = store
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        let listing = store.list_directory("main", &root, &cancellation).unwrap();
        let entries = listing["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["type"], "dir");
        assert_eq!(entries[1]["format"], "markdown");

        let search = store
            .search_markdown("main", &[root], "needle", 100, &cancellation)
            .unwrap();
        assert_eq!(search["results"][0]["matchKind"], "content");
        assert_eq!(search["results"][0]["snippet"], "needle line");
    }

    #[test]
    fn rejects_oversized_and_invalid_utf8_documents() {
        let directory = tempdir().unwrap();
        let oversized = directory.path().join("large.md");
        let invalid = directory.path().join("invalid.md");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        File::create(&invalid)
            .unwrap()
            .write_all(&[0xff, 0xfe])
            .unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_markdown("main", &path_to_locator(&oversized), &cancellation)
                .unwrap_err()
                .error,
            "FILE_TOO_LARGE"
        );
        assert_eq!(
            store
                .read_markdown("main", &path_to_locator(&invalid), &cancellation)
                .unwrap_err()
                .error,
            "INVALID_UTF8"
        );

        let oversized_state = store
            .stable_markdown_state("main", &path_to_locator(&oversized), &cancellation)
            .unwrap();
        assert_eq!(oversized_state.metadata.len(), MAX_DOCUMENT_BYTES + 1);
        assert_eq!(oversized_state.content_sha256.len(), 64);
        assert_eq!(oversized_state.revision.len(), 64);
        assert!(oversized_state
            .revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        let invalid_state = store
            .stable_markdown_state("main", &path_to_locator(&invalid), &cancellation)
            .unwrap();
        assert_eq!(invalid_state.content_sha256.len(), 64);
    }

    #[test]
    fn enforces_search_result_and_tree_depth_limits() {
        let directory = tempdir().unwrap();
        for index in 0..=MAX_SEARCH_RESULTS {
            fs::write(
                directory.path().join(format!("needle-{index:03}.md")),
                "content",
            )
            .unwrap();
        }
        let mut nested = directory.path().join("deep-root");
        fs::create_dir(&nested).unwrap();
        for _ in 0..MAX_TREE_DEPTH {
            nested = nested.join("d");
            fs::create_dir(&nested).unwrap();
        }
        let store = AuthorizationStore::default();
        let root = store
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        let search = store
            .search_markdown("main", &[root.clone()], "needle", 10_000, &cancellation)
            .unwrap();
        assert_eq!(
            search["results"].as_array().unwrap().len(),
            MAX_SEARCH_RESULTS
        );
        assert_eq!(search["truncated"], true);
        assert_eq!(
            store
                .workspace_state("main", &root, &cancellation)
                .unwrap_err()
                .error,
            "WORKSPACE_SCAN_LIMIT"
        );
    }

    #[test]
    fn image_reader_rejects_files_over_twenty_five_mib() {
        let directory = tempdir().unwrap();
        let image = directory.path().join("large.png");
        File::create(&image)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", directory.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_image("main", directory.path(), &image, true, &cancellation,)
                .unwrap_err()
                .error,
            "IMAGE_TOO_LARGE"
        );
    }

    #[test]
    fn local_resource_reader_scopes_sibling_access_to_images() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("selected.md");
        let sibling_markdown = directory.path().join("private.md");
        let image = directory.path().join("cover.png");
        fs::write(&document, "![cover](cover.png)").unwrap();
        fs::write(&sibling_markdown, "private").unwrap();
        fs::write(&image, [137, 80, 78, 71, 13, 10, 26, 10, 0]).unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", &document, AuthorizationKind::File)
            .unwrap();
        let (_lease, cancellation) = token();

        let (data, mime_type) = store
            .read_local_image(
                "main",
                &path_to_locator(&document),
                "cover.png",
                None,
                &cancellation,
            )
            .unwrap();
        assert_eq!(mime_type, "image/png");
        assert_eq!(data, [137, 80, 78, 71, 13, 10, 26, 10, 0]);
        assert_eq!(
            store
                .read_markdown("main", &path_to_locator(&sibling_markdown), &cancellation,)
                .unwrap_err()
                .error,
            "PATH_NOT_AUTHORIZED"
        );
    }

    #[test]
    fn local_resource_reader_rejects_traversal_and_invalid_content() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let document = workspace.path().join("selected.md");
        let fake_image = workspace.path().join("fake.png");
        let outside_image = outside.path().join("outside.png");
        fs::write(&document, "document").unwrap();
        fs::write(&fake_image, "not an image").unwrap();
        fs::write(&outside_image, [137, 80, 78, 71, 13, 10, 26, 10]).unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", &document, AuthorizationKind::File)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_local_image(
                    "main",
                    &path_to_locator(&document),
                    "../outside.png",
                    None,
                    &cancellation,
                )
                .unwrap_err()
                .error,
            "RESOURCE_OUTSIDE_WORKSPACE"
        );
        assert_eq!(
            store
                .read_local_image(
                    "main",
                    &path_to_locator(&document),
                    "fake.png",
                    None,
                    &cancellation,
                )
                .unwrap_err()
                .error,
            "INVALID_IMAGE_CONTENT"
        );
        assert_eq!(
            store
                .read_local_image(
                    "main",
                    &path_to_locator(&document),
                    "bad%2.png",
                    None,
                    &cancellation,
                )
                .unwrap_err()
                .error,
            "INVALID_RESOURCE_PATH"
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_resource_reader_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let document = workspace.path().join("selected.md");
        let outside_image = outside.path().join("outside.png");
        fs::write(&document, "document").unwrap();
        fs::write(&outside_image, [137, 80, 78, 71, 13, 10, 26, 10]).unwrap();
        symlink(&outside_image, workspace.path().join("escape.png")).unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", &document, AuthorizationKind::File)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_local_image(
                    "main",
                    &path_to_locator(&document),
                    "escape.png",
                    None,
                    &cancellation,
                )
                .unwrap_err()
                .error,
            "RESOURCE_OUTSIDE_WORKSPACE"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_boundary_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let selected = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.md");
        fs::write(&secret, "secret").unwrap();
        let link = selected.path().join("escape.md");
        symlink(&secret, &link).unwrap();
        let store = AuthorizationStore::default();
        store
            .authorize_selection("main", selected.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        assert_eq!(
            store
                .read_markdown("main", &path_to_locator(&link), &cancellation)
                .unwrap_err()
                .error,
            "PATH_NOT_AUTHORIZED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_tree_never_follows_symlinks_even_when_they_stay_inside_root() {
        use std::os::unix::fs::symlink;

        let selected = tempdir().unwrap();
        let target = selected.path().join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("secret.md"), "secret").unwrap();
        symlink(&target, selected.path().join("alias")).unwrap();
        let store = AuthorizationStore::default();
        let root = store
            .authorize_selection("main", selected.path(), AuthorizationKind::Directory)
            .unwrap();
        let (_lease, cancellation) = token();

        let listing = store.list_directory("main", &root, &cancellation).unwrap();
        let names = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["real"]);
    }
}
