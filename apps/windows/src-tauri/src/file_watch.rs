use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

use crate::{error::ApiError, file_access::AuthorizationKind, safe_save::is_internal_sidecar_name};

pub const FILE_CHANGED_EVENT: &str = "flux-reader:file-changed";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangedPayload {
    sequence: u64,
}

struct WatchRegistration {
    authorization_root: PathBuf,
    kind: AuthorizationKind,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
struct FileWatchState {
    registrations: HashMap<String, Vec<WatchRegistration>>,
    closed_webviews: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct FileWatchService {
    state: Arc<Mutex<FileWatchState>>,
    sequence: Arc<AtomicU64>,
}

fn watch_error() -> ApiError {
    // notify 的底层错误可能携带绝对路径，不能透过 IPC 原样返回。
    ApiError::new(
        "FILE_WATCH_UNAVAILABLE",
        "无法为所选路径建立系统文件变更监听",
        503,
    )
}

fn is_internal_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_internal_sidecar_name)
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "avif"
                    | "bmp"
                    | "gif"
                    | "heic"
                    | "heif"
                    | "jpeg"
                    | "jpg"
                    | "png"
                    | "tif"
                    | "tiff"
                    | "webp"
            )
        })
}

fn should_emit(event: &Event, root: &Path, kind: AuthorizationKind) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    let visible_paths = event
        .paths
        .iter()
        .filter(|path| !is_internal_path(path))
        .collect::<Vec<_>>();
    if event.paths.is_empty() {
        return true;
    }
    if visible_paths.is_empty() {
        return false;
    }
    match kind {
        AuthorizationKind::Directory => true,
        AuthorizationKind::File => {
            let parent = root.parent();
            visible_paths.iter().any(|path| {
                let path = path.as_path();
                path == root
                    || parent == Some(path)
                    || (path.parent() == parent && is_supported_image_path(path))
            })
        }
    }
}

impl FileWatchService {
    pub fn watch_selection(
        &self,
        app: &AppHandle,
        webview: &str,
        selected: &Path,
        kind: AuthorizationKind,
    ) -> Result<(), ApiError> {
        let canonical = fs::canonicalize(selected).map_err(|_| watch_error())?;
        let metadata = fs::metadata(&canonical).map_err(|_| watch_error())?;
        if (kind == AuthorizationKind::File && !metadata.is_file())
            || (kind == AuthorizationKind::Directory && !metadata.is_dir())
        {
            return Err(watch_error());
        }

        // 注册与窗口销毁共用同一把锁：若 dialog 在窗口关闭后才返回，不能重新
        // 建立无人持有、也无法再由生命周期事件清理的系统 watcher。
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closed_webviews.contains(webview) {
            return Err(ApiError::new("WEBVIEW_CLOSED", "选择文件的窗口已关闭", 410));
        }
        let current = state.registrations.entry(webview.to_owned()).or_default();
        if current
            .iter()
            .any(|item| item.authorization_root == canonical && item.kind == kind)
        {
            return Ok(());
        }

        let watched_path = match kind {
            AuthorizationKind::Directory => canonical.clone(),
            // 原子替换会让旧文件 inode 离开目标路径；监听父目录才能持续观察后续替换。
            AuthorizationKind::File => canonical.parent().ok_or_else(watch_error)?.to_owned(),
        };
        let recursive = match kind {
            AuthorizationKind::Directory => RecursiveMode::Recursive,
            AuthorizationKind::File => RecursiveMode::NonRecursive,
        };
        let target = canonical.clone();
        let label = webview.to_owned();
        let app = app.clone();
        let sequence = self.sequence.clone();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            // 后端报告溢出/失步时也触发一次完整刷新；事件中始终不携带路径。
            if result.is_err() || result.is_ok_and(|event| should_emit(&event, &target, kind)) {
                let payload = FileChangedPayload {
                    sequence: sequence.fetch_add(1, Ordering::Relaxed) + 1,
                };
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    FILE_CHANGED_EVENT,
                    payload,
                );
            }
        })
        .map_err(|_| watch_error())?;
        watcher
            .watch(&watched_path, recursive)
            .map_err(|_| watch_error())?;
        current.push(WatchRegistration {
            authorization_root: canonical,
            kind,
            _watcher: watcher,
        });
        Ok(())
    }

    pub fn remove_webview(&self, webview: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.closed_webviews.insert(webview.to_owned());
        state.registrations.remove(webview);
    }
}

#[cfg(test)]
mod tests {
    use notify::event::{AccessKind, CreateKind, ModifyKind};

    use super::*;

    #[test]
    fn filters_reads_private_sidecars_and_unrelated_siblings() {
        let root = Path::new("/workspace/selected.md");
        let read = Event::new(EventKind::Access(AccessKind::Any)).add_path(root.to_owned());
        assert!(!should_emit(&read, root, AuthorizationKind::File));

        let sidecar = Event::new(EventKind::Modify(ModifyKind::Any)).add_path(PathBuf::from(
            "/workspace/.flux-reader-recovery-0123456789abcdef01234567-0123456789abcdef0123456789abcdef0123456789abcdef-baseline.md",
        ));
        assert!(!should_emit(&sidecar, root, AuthorizationKind::File));

        let sibling = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/workspace/other.md"));
        assert!(!should_emit(&sibling, root, AuthorizationKind::File));

        let image = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/workspace/cover.png"));
        assert!(should_emit(&image, root, AuthorizationKind::File));

        let target = Event::new(EventKind::Create(CreateKind::File)).add_path(root.to_owned());
        assert!(should_emit(&target, root, AuthorizationKind::File));
    }

    #[test]
    fn directory_watch_emits_visible_changes_without_exposing_paths_in_payload() {
        let root = Path::new("/workspace");
        let event = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/workspace/docs/a.md"));
        assert!(should_emit(&event, root, AuthorizationKind::Directory));

        let payload = serde_json::to_value(FileChangedPayload { sequence: 7 }).unwrap();
        assert_eq!(payload, serde_json::json!({ "sequence": 7 }));
    }

    #[test]
    fn destroyed_webviews_cannot_acquire_new_watchers() {
        let service = FileWatchService::default();
        service.remove_webview("main");

        let state = service
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(state.closed_webviews.contains("main"));
        assert!(!state.registrations.contains_key("main"));
    }
}
