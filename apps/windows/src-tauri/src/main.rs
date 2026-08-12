#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod file_access;
mod file_watch;
mod request_registry;
mod resource_protocol;
mod safe_save;
mod transport;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

use crate::{
    error::ApiError,
    file_access::{AuthorizationKind, AuthorizationStore},
    file_watch::FileWatchService,
    request_registry::RequestRegistry,
    safe_save::SafeSaveService,
    transport::TransportRequest,
};

#[derive(Clone, Default)]
struct AppState {
    files: AuthorizationStore,
    file_watch: FileWatchService,
    requests: RequestRegistry,
    safe_save: SafeSaveService,
}

#[tauri::command]
async fn reader_transport_request(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: TransportRequest,
) -> Result<Value, ApiError> {
    let webview = window.label().to_owned();
    let lease = state.requests.register(&webview, &request.id)?;
    let cancellation = lease.token();
    let files = state.files.clone();
    let safe_save = state.safe_save.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        transport::dispatch(&files, &safe_save, &webview, &request, &cancellation)
    })
    .await
    .map_err(|_| ApiError::new("TRANSPORT_TASK_FAILED", "文件任务意外终止", 500))?;
    drop(lease);
    result
}

#[tauri::command]
fn reader_transport_cancel(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> bool {
    state.requests.cancel(window.label(), &request_id)
}

fn selected_path(path: tauri_plugin_dialog::FilePath) -> Result<std::path::PathBuf, ApiError> {
    path.simplified().into_path().map_err(|_| {
        ApiError::new(
            "INVALID_SELECTED_PATH",
            "原生选择器没有返回可访问的文件系统路径",
            400,
        )
    })
}

#[tauri::command]
async fn reader_pick_folder(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, ApiError> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_title("打开文件夹")
        .pick_folder(move |selection| {
            let _ = sender.blocking_send(selection);
        });
    let selection = receiver
        .recv()
        .await
        .ok_or_else(|| ApiError::new("DIALOG_FAILED", "文件夹选择器意外关闭", 500))?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let selected = selected_path(selection)?;
    let locator =
        state
            .files
            .authorize_selection(window.label(), &selected, AuthorizationKind::Directory)?;
    state.file_watch.watch_selection(
        window.app_handle(),
        window.label(),
        &selected,
        AuthorizationKind::Directory,
    )?;
    Ok(Some(locator))
}

#[tauri::command]
async fn reader_pick_markdown_file(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, ApiError> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_title("打开 Markdown 文件")
        .add_filter("Markdown", &["md", "markdown", "mdx"])
        .pick_file(move |selection| {
            let _ = sender.blocking_send(selection);
        });
    let selection = receiver
        .recv()
        .await
        .ok_or_else(|| ApiError::new("DIALOG_FAILED", "文件选择器意外关闭", 500))?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let selected = selected_path(selection)?;
    if !matches!(
        selected
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mdx")
    ) {
        return Err(ApiError::new(
            "UNSUPPORTED_DOCUMENT_TYPE",
            "仅支持 .md / .markdown / .mdx 文件",
            400,
        ));
    }
    let locator =
        state
            .files
            .authorize_selection(window.label(), &selected, AuthorizationKind::File)?;
    state.file_watch.watch_selection(
        window.app_handle(),
        window.label(),
        &selected,
        AuthorizationKind::File,
    )?;
    Ok(Some(locator))
}

#[tauri::command]
fn reader_set_title(window: WebviewWindow, title: String) -> Result<(), ApiError> {
    let safe_title = title
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect::<String>();
    window
        .set_title(if safe_title.is_empty() {
            "Flux Reader"
        } else {
            &safe_title
        })
        .map_err(|_| ApiError::new("WINDOW_TITLE_FAILED", "无法更新窗口标题", 500))
}

fn dispatch_dom_event(app: &tauri::AppHandle, event_name: &str) {
    let script = match event_name {
        "open-file" => "window.dispatchEvent(new Event('flux-reader:open-file'));",
        "open-folder" => "window.dispatchEvent(new Event('flux-reader:open-folder'));",
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn main() {
    let app_state = AppState::default();
    let resource_files = app_state.files.clone();
    tauri::Builder::default()
        .manage(app_state)
        .register_asynchronous_uri_scheme_protocol(
            "flux-reader-resource",
            move |context, request, responder| {
                let files = resource_files.clone();
                let webview = context.webview_label().to_owned();
                std::thread::spawn(move || {
                    responder.respond(resource_protocol::handle(&files, &webview, &request));
                });
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            let open_file = MenuItem::with_id(app, "open-file", "打开文件…", true, Some("Ctrl+O"))?;
            let open_folder = MenuItem::with_id(
                app,
                "open-folder",
                "打开文件夹…",
                true,
                Some("Ctrl+Shift+O"),
            )?;
            let close_window =
                MenuItem::with_id(app, "close-window", "关闭窗口", true, Some("Ctrl+W"))?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, Some("Alt+F4"))?;
            let file = Submenu::with_items(
                app,
                "文件",
                true,
                &[&open_file, &open_folder, &close_window, &quit],
            )?;
            Menu::with_items(app, &[&file])
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-file" => dispatch_dom_event(app, "open-file"),
            "open-folder" => dispatch_dom_event(app, "open-folder"),
            "close-window" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                state.requests.remove_webview(window.label());
                state.files.remove_webview(window.label());
                state.file_watch.remove_webview(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            reader_transport_request,
            reader_transport_cancel,
            reader_pick_folder,
            reader_pick_markdown_file,
            reader_set_title
        ])
        .run(tauri::generate_context!())
        .expect("Flux Reader Tauri runtime failed");
}
