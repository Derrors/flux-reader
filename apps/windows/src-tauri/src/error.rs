use serde::Serialize;
use serde_json::Value;

/** IPC 错误保持与 fnOS JSON 错误相同的 message/error/status 形状。 */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub error: String,
    pub message: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(error: impl Into<String>, message: impl Into<String>, status: u16) -> Self {
        Self {
            error: error.into(),
            message: message.into(),
            status,
            details: None,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}
