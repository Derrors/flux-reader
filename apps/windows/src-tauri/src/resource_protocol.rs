use serde_json::json;
use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::{
    error::ApiError, file_access::AuthorizationStore, request_registry::CancellationToken,
};

const RESOURCE_ROUTE: &str = "/image";
const MAX_RESOURCE_REQUEST_LENGTH: usize = 16 * 1024;

#[derive(Debug, Eq, PartialEq)]
struct ResourceRequest {
    document: String,
    source: String,
    workspace: Option<String>,
}

fn parse_request(request: &Request<Vec<u8>>) -> Result<ResourceRequest, ApiError> {
    if request.method() != Method::GET {
        return Err(ApiError::new(
            "RESOURCE_METHOD_NOT_ALLOWED",
            "本地图片协议只接受 GET 请求",
            405,
        ));
    }
    if request.uri().path() != RESOURCE_ROUTE
        || request.uri().to_string().len() > MAX_RESOURCE_REQUEST_LENGTH
    {
        return Err(ApiError::new(
            "INVALID_RESOURCE_REQUEST",
            "本地图片请求无效",
            400,
        ));
    }
    let query = request
        .uri()
        .query()
        .ok_or_else(|| ApiError::new("INVALID_RESOURCE_REQUEST", "本地图片请求缺少参数", 400))?;
    let mut document = None;
    let mut source = None;
    let mut workspace = None;
    let mut version_seen = false;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match key.as_ref() {
            "document" => &mut document,
            "path" => &mut source,
            "workspace" => &mut workspace,
            // v 只负责让 DOM URL 在资源版本变化时更新，不能参与文件定位。
            "v" if !version_seen => {
                version_seen = true;
                continue;
            }
            "v" => {
                return Err(ApiError::new(
                    "INVALID_RESOURCE_REQUEST",
                    "本地图片请求包含重复参数",
                    400,
                ));
            }
            _ => {
                return Err(ApiError::new(
                    "INVALID_RESOURCE_REQUEST",
                    "本地图片请求包含未知参数",
                    400,
                ));
            }
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(ApiError::new(
                "INVALID_RESOURCE_REQUEST",
                "本地图片请求包含重复参数",
                400,
            ));
        }
    }
    let document = document.filter(|value| !value.is_empty()).ok_or_else(|| {
        ApiError::new("INVALID_RESOURCE_REQUEST", "本地图片请求缺少 document", 400)
    })?;
    let source = source
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::new("INVALID_RESOURCE_REQUEST", "本地图片请求缺少 path", 400))?;
    Ok(ResourceRequest {
        document,
        source,
        workspace: workspace.filter(|value| !value.is_empty()),
    })
}

fn response(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store, max-age=0")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .expect("静态协议响应头必须有效")
}

fn error_response(error: ApiError) -> Response<Vec<u8>> {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    // 不回传 message/details，防止未来底层错误文字意外携带私有路径。
    let body = serde_json::to_vec(&json!({
        "error": error.error,
        "message": "本地图片不可用"
    }))
    .unwrap_or_else(|_| b"{\"error\":\"RESOURCE_FAILED\"}".to_vec());
    response(status, "application/json; charset=utf-8", body)
}

pub fn handle(
    files: &AuthorizationStore,
    webview: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let result = parse_request(request).and_then(|request| {
        files.read_local_image(
            webview,
            &request.document,
            &request.source,
            request.workspace.as_deref(),
            &CancellationToken::default(),
        )
    });
    match result {
        Ok((data, mime_type)) => response(StatusCode::OK, mime_type, data),
        Err(error) => error_response(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn parses_exact_resource_route_and_decodes_query_once() {
        let parsed = parse_request(&request(
            "http://flux-reader-resource.localhost/image?document=C%3A%2Fdocs%2Fa.md&path=cover%2520one.png&workspace=C%3A%2Fdocs&v=revision",
        ))
        .unwrap();
        assert_eq!(parsed.document, "C:/docs/a.md");
        assert_eq!(parsed.source, "cover%20one.png");
        assert_eq!(parsed.workspace.as_deref(), Some("C:/docs"));
    }

    #[test]
    fn rejects_duplicate_unknown_and_non_get_requests() {
        assert_eq!(
            parse_request(&request(
                "http://flux-reader-resource.localhost/image?document=a&document=b&path=c"
            ))
            .unwrap_err()
            .error,
            "INVALID_RESOURCE_REQUEST"
        );
        assert_eq!(
            parse_request(&request(
                "http://flux-reader-resource.localhost/image?document=a&path=b&secret=c"
            ))
            .unwrap_err()
            .error,
            "INVALID_RESOURCE_REQUEST"
        );
        assert_eq!(
            parse_request(&request(
                "http://flux-reader-resource.localhost/image?document=a&path=b&v=1&v=2"
            ))
            .unwrap_err()
            .error,
            "INVALID_RESOURCE_REQUEST"
        );
        let post = Request::builder()
            .method(Method::POST)
            .uri("http://flux-reader-resource.localhost/image?document=a&path=b")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            parse_request(&post).unwrap_err().error,
            "RESOURCE_METHOD_NOT_ALLOWED"
        );
    }
}
