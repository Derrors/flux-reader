use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use crate::error::ApiError;

type RequestKey = (String, String);

#[derive(Clone, Default)]
pub struct RequestRegistry {
    active: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>>,
    closed_webviews: Arc<Mutex<std::collections::HashSet<String>>>,
}

#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn check(&self) -> Result<(), ApiError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ApiError::new("REQUEST_ABORTED", "请求已取消", 499))
        } else {
            Ok(())
        }
    }
}

pub struct RequestLease {
    registry: RequestRegistry,
    key: RequestKey,
    token: Arc<AtomicBool>,
}

impl RequestLease {
    pub fn token(&self) -> CancellationToken {
        CancellationToken {
            cancelled: Arc::clone(&self.token),
        }
    }
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        let mut active = self
            .registry
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active
            .get(&self.key)
            .is_some_and(|token| Arc::ptr_eq(token, &self.token))
        {
            active.remove(&self.key);
        }
    }
}

impl RequestRegistry {
    pub fn register(&self, webview: &str, request_id: &str) -> Result<RequestLease, ApiError> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ApiError::new(
                "INVALID_REQUEST_ID",
                "request id 格式无效",
                400,
            ));
        }
        let closed_webviews = self
            .closed_webviews
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if closed_webviews.contains(webview) {
            return Err(ApiError::new("WEBVIEW_CLOSED", "发起请求的窗口已关闭", 410));
        }
        let key = (webview.to_owned(), request_id.to_owned());
        let token = Arc::new(AtomicBool::new(false));
        // 与 remove_webview 固定使用 closed_webviews -> active 的锁顺序。
        // 持有读到的关闭状态直到插入完成，避免窗口销毁后漏进新任务。
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.contains_key(&key) {
            return Err(ApiError::new(
                "DUPLICATE_REQUEST_ID",
                "同一窗口中存在重复的 request id",
                409,
            ));
        }
        active.insert(key.clone(), Arc::clone(&token));
        Ok(RequestLease {
            registry: self.clone(),
            key,
            token,
        })
    }

    /** webview label 由 Tauri 注入，调用方不能取消其他窗口的任务。 */
    pub fn cancel(&self, webview: &str, request_id: &str) -> bool {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(token) = active.get(&(webview.to_owned(), request_id.to_owned())) else {
            return false;
        };
        token.store(true, Ordering::Release);
        true
    }

    pub fn remove_webview(&self, webview: &str) {
        let mut closed_webviews = self
            .closed_webviews
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        closed_webviews.insert(webview.to_owned());
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        active.retain(|(label, _), token| {
            if label == webview {
                token.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_scoped_to_the_originating_webview() {
        let registry = RequestRegistry::default();
        let main = registry.register("main", "request-1").unwrap();
        let secondary = registry.register("secondary", "request-1").unwrap();

        assert!(!registry.cancel("unknown", "request-1"));
        assert!(registry.cancel("main", "request-1"));
        assert!(main.token().check().is_err());
        assert!(secondary.token().check().is_ok());
    }

    #[test]
    fn duplicate_active_ids_are_rejected_but_reusable_after_completion() {
        let registry = RequestRegistry::default();
        let lease = registry.register("main", "request-1").unwrap();
        let duplicate = match registry.register("main", "request-1") {
            Ok(_) => panic!("重复的活动 request id 不应注册成功"),
            Err(error) => error,
        };
        assert_eq!(duplicate.error, "DUPLICATE_REQUEST_ID");
        drop(lease);
        assert!(registry.register("main", "request-1").is_ok());
    }

    #[test]
    fn destroyed_webview_cannot_register_more_work() {
        let registry = RequestRegistry::default();
        let lease = registry.register("main", "request-1").unwrap();
        registry.remove_webview("main");
        assert!(lease.token().check().is_err());
        let error = match registry.register("main", "request-2") {
            Ok(_) => panic!("销毁窗口不应继续注册请求"),
            Err(error) => error,
        };
        assert_eq!(error.error, "WEBVIEW_CLOSED");
    }
}
