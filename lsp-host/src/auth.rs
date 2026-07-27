use axum::http::HeaderMap;

/// Any locally running webpage can attempt to open a WebSocket to a
/// 127.0.0.1 port, so every upgrade request must be checked against both
/// the extension's Origin and a shared secret before it's accepted.
/// The browser `WebSocket` API cannot set custom headers, so the token is
/// carried in `Sec-WebSocket-Protocol` instead of a header or query string
/// (a query string would risk leaking the token into local log lines).
/// Mirrors terminal-host/src/auth.rs exactly.
pub fn is_authorized(headers: &HeaderMap, expected_origin: &str, expected_token: &str) -> bool {
    let origin_ok = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|origin| origin == expected_origin);

    let token_ok = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|protocol| protocol == expected_token);

    origin_ok && token_ok
}
