use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    error::ApiError,
    file_access::{AuthorizationStore, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES},
    request_registry::CancellationToken,
    safe_save::{
        RecoveryCommitRequest, SafeSaveService, MAX_RECOVERY_BYTES_PER_DOCUMENT,
        MAX_RECOVERY_TRANSACTIONS_PER_DOCUMENT, RECOVERY_RETENTION_DAYS,
    },
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportRequest {
    pub id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Map<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody {
    path: String,
    content: String,
    #[serde(default)]
    expected_revision: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryCommitBody {
    path: String,
    recovery_id: String,
    version: String,
    #[serde(default)]
    expected_revision: Option<String>,
}

fn missing_query(name: &str) -> ApiError {
    ApiError::new("MISSING_PATH", format!("缺少 {name} 参数"), 400)
}

fn query_string(request: &TransportRequest, name: &str) -> Result<String, ApiError> {
    request
        .query
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| missing_query(name))
}

fn query_strings(request: &TransportRequest, name: &str) -> Result<Vec<String>, ApiError> {
    let Some(value) = request.query.get(name) else {
        return Err(missing_query(name));
    };
    let values = match value {
        Value::String(value) if !value.is_empty() => vec![value.clone()],
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    if values.is_empty() {
        Err(missing_query(name))
    } else {
        Ok(values)
    }
}

fn search_limit(request: &TransportRequest) -> usize {
    let value = request
        .query
        .get("limit")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(100.0)
        .floor();
    value.clamp(1.0, 100.0) as usize
}

fn known_path(path: &str) -> bool {
    matches!(
        path,
        "/env"
            | "/list"
            | "/file"
            | "/file-state"
            | "/search"
            | "/workspace-state"
            | "/file-recovery"
            | "/file-recovery/commit"
    )
}

/** 白名单分派是唯一 transport 入口；不能把 path 拼成文件系统路径或命令名。 */
pub fn dispatch(
    files: &AuthorizationStore,
    safe_save: &SafeSaveService,
    webview: &str,
    request: &TransportRequest,
    cancellation: &CancellationToken,
) -> Result<Value, ApiError> {
    cancellation.check()?;
    if request.path.len() > 128 || !request.path.starts_with('/') {
        return Err(ApiError::new(
            "INVALID_TRANSPORT_PATH",
            "transport path 格式无效",
            400,
        ));
    }
    let method = request.method.as_str();
    match (method, request.path.as_str()) {
        ("GET", "/env") => Ok(json!({
            "appName": "flux-reader",
            "basePath": "",
            "openApiAvailable": true,
            "uid": "windows-local",
            "mode": "tauri",
            "platform": "windows",
            "capabilitySchemaVersion": 1,
            "capabilities": {
                "nativeDialog": true,
                "sessionScopedAuthorization": true,
                "requestCancellation": true,
                "workspaceSearch": true,
                "safeSave": true,
                "recovery": true,
                "localResources": true,
                "fileWatching": true,
                "safeSaveSemantics": {
                    "writeVisibility": "atomicReplace",
                    "recoveryLocation": "sidecar"
                },
                "recoveryPolicy": {
                    "cleanupMode": "explicit",
                    "retentionDays": RECOVERY_RETENTION_DAYS,
                    "automaticExpiry": false,
                    "maxTransactionsPerDocument": MAX_RECOVERY_TRANSACTIONS_PER_DOCUMENT,
                    "maxBytesPerDocument": MAX_RECOVERY_BYTES_PER_DOCUMENT
                }
            },
            "policy": {
                "maxEditableDocumentBytes": MAX_DOCUMENT_BYTES,
                "maxLocalImageBytes": MAX_IMAGE_BYTES,
                "maxWorkspaces": 8,
                "maxDocumentTabs": 12
            }
        })),
        ("GET", "/list") => {
            let path = query_string(request, "path")?;
            files.list_directory(webview, &path, cancellation)
        }
        ("GET", "/file") => {
            let path = query_string(request, "path")?;
            let mut result = files.read_markdown(webview, &path, cancellation)?;
            safe_save.attach_recovery(files, webview, &path, &mut result, cancellation);
            Ok(result)
        }
        ("GET", "/file-state") => {
            let path = query_string(request, "path")?;
            let mut result = files.markdown_state(webview, &path, cancellation)?;
            safe_save.attach_recovery(files, webview, &path, &mut result, cancellation);
            Ok(result)
        }
        ("GET", "/search") => {
            let paths = query_strings(request, "path")?;
            let query = request.query.get("q").and_then(Value::as_str).unwrap_or("");
            files.search_markdown(webview, &paths, query, search_limit(request), cancellation)
        }
        ("GET", "/workspace-state") => {
            let path = query_string(request, "path")?;
            files.workspace_state(webview, &path, cancellation)
        }
        ("PUT", "/file") => {
            let body = request
                .body
                .clone()
                .ok_or_else(|| safe_save.invalid_request("保存请求缺少 body"))?;
            let body: SaveBody = serde_json::from_value(body)
                .map_err(|_| safe_save.invalid_request("保存请求字段无效"))?;
            safe_save.save_update(
                files,
                webview,
                body.path,
                body.content,
                body.expected_revision,
                cancellation,
            )
        }
        ("GET", "/file-recovery") => {
            let path = query_string(request, "path")?;
            match (
                request.query.get("recoveryId").and_then(Value::as_str),
                request.query.get("version").and_then(Value::as_str),
            ) {
                (None, None) => safe_save.recovery_state(files, webview, &path, cancellation),
                (Some(recovery_id), Some(version)) => safe_save.read_recovery_version(
                    files,
                    webview,
                    &path,
                    recovery_id,
                    version,
                    cancellation,
                ),
                _ => Err(ApiError::new(
                    "MISSING_RECOVERY_ARGUMENT",
                    "读取恢复正文必须同时提供 recoveryId 和 version",
                    400,
                )),
            }
        }
        ("POST", "/file-recovery/commit") => {
            let body = request
                .body
                .clone()
                .ok_or_else(|| safe_save.invalid_request("恢复提交缺少 body"))?;
            let body: RecoveryCommitBody = serde_json::from_value(body)
                .map_err(|_| safe_save.invalid_request("恢复提交字段无效"))?;
            safe_save.commit_recovery(
                files,
                webview,
                RecoveryCommitRequest {
                    locator: body.path,
                    recovery_id: body.recovery_id,
                    version: body.version,
                    expected_revision: body.expected_revision,
                },
                cancellation,
            )
        }
        ("DELETE", "/file-recovery") => {
            let path = query_string(request, "path")?;
            let recovery_id = query_string(request, "recoveryId")?;
            safe_save.discard_recovery(files, webview, &path, &recovery_id, cancellation)
        }
        _ if known_path(&request.path) => Err(ApiError::new(
            "METHOD_NOT_ALLOWED",
            format!("{} 不支持 {} 方法", request.path, request.method),
            405,
        )),
        _ => Err(ApiError::new(
            "TRANSPORT_PATH_NOT_FOUND",
            format!("未实现的 transport path：{}", request.path),
            404,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request_registry::RequestRegistry;

    fn request(method: &str, path: &str) -> TransportRequest {
        TransportRequest {
            id: "request-1".to_owned(),
            method: method.to_owned(),
            path: path.to_owned(),
            query: Map::new(),
            body: None,
        }
    }

    fn token() -> (crate::request_registry::RequestLease, CancellationToken) {
        let registry = RequestRegistry::default();
        let lease = registry.register("main", "transport-test").unwrap();
        let token = lease.token();
        (lease, token)
    }

    #[test]
    fn env_declares_staged_capabilities() {
        let (_lease, cancellation) = token();
        let result = dispatch(
            &AuthorizationStore::default(),
            &SafeSaveService::default(),
            "main",
            &request("GET", "/env"),
            &cancellation,
        )
        .unwrap();
        assert_eq!(result["platform"], "windows");
        assert_eq!(result["capabilitySchemaVersion"], 1);
        assert_eq!(result["capabilities"]["safeSave"], true);
        assert_eq!(result["capabilities"]["recovery"], true);
        assert_eq!(result["capabilities"]["sessionScopedAuthorization"], true);
        assert_eq!(result["capabilities"]["workspaceSearch"], true);
        assert_eq!(result["capabilities"]["localResources"], true);
        assert_eq!(result["capabilities"]["fileWatching"], true);
        assert_eq!(
            result["policy"]["maxEditableDocumentBytes"],
            MAX_DOCUMENT_BYTES
        );
        assert_eq!(result["policy"]["maxLocalImageBytes"], MAX_IMAGE_BYTES);
        assert_eq!(result["policy"]["maxWorkspaces"], 8);
        assert_eq!(result["policy"]["maxDocumentTabs"], 12);
        assert_eq!(
            result["capabilities"]["recoveryPolicy"]["automaticExpiry"],
            false
        );
    }

    #[test]
    fn whitelist_distinguishes_unknown_paths_and_methods() {
        let (_lease, cancellation) = token();
        let files = AuthorizationStore::default();
        assert_eq!(
            dispatch(
                &files,
                &SafeSaveService::default(),
                "main",
                &request("POST", "/env"),
                &cancellation,
            )
            .unwrap_err()
            .error,
            "METHOD_NOT_ALLOWED"
        );
        assert_eq!(
            dispatch(
                &files,
                &SafeSaveService::default(),
                "main",
                &request("GET", "/unknown"),
                &cancellation,
            )
            .unwrap_err()
            .error,
            "TRANSPORT_PATH_NOT_FOUND"
        );
    }

    #[test]
    fn save_and_recovery_paths_validate_structured_arguments() {
        let (_lease, cancellation) = token();
        let files = AuthorizationStore::default();
        let safe_save = SafeSaveService::default();
        assert_eq!(
            dispatch(
                &files,
                &safe_save,
                "main",
                &request("PUT", "/file"),
                &cancellation,
            )
            .unwrap_err()
            .details
            .and_then(|value| value.get("saveOutcome").cloned())
            .and_then(|value| value.get("kind").cloned()),
            Some(Value::String("rejected".to_owned()))
        );
        assert_eq!(
            dispatch(
                &files,
                &safe_save,
                "main",
                &request("GET", "/file-recovery"),
                &cancellation,
            )
            .unwrap_err()
            .error,
            "MISSING_PATH"
        );
    }
}
