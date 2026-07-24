//! Native Messaging host mode: lets the extension ask the browser to launch
//! `terminal-host` itself, since a browser extension has no other way to
//! start a local OS process. Invoked by the browser with the calling
//! extension's origin as argv[1] (see `main.rs`'s dispatch check) and talks
//! length-prefixed JSON over stdin/stdout, per the Native Messaging spec:
//! https://developer.chrome.com/docs/apps/nativeMessaging
//!
//! This mode only ever handles a single request/response pair (the
//! extension calls it via `chrome.runtime.sendNativeMessage`, which spawns
//! the host, exchanges one message, and tears it down), then exits — the
//! actual WS server keeps running afterward as an independent detached
//! process, unaffected by this short-lived launcher invocation.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::config;
use crate::ws_server::HEALTH_RESPONSE;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);

fn log(line: &str) {
    let path = std::env::temp_dir().join("terminal-host-native-messaging.log");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| writeln!(f, "[{now}] {line}"));
}

pub fn run() -> anyhow::Result<()> {
    log("native_messaging::run() invoked");
    let request = match read_message() {
        Ok(Some(req)) => req,
        Ok(None) => {
            log("stdin closed before a message arrived (EOF)");
            return Ok(());
        }
        Err(err) => {
            log(&format!("read_message failed: {err}"));
            return Err(err);
        }
    };
    log(&format!("received: {request}"));

    let response = match request.get("cmd").and_then(|v| v.as_str()) {
        Some("start") => handle_start(),
        _ => serde_json::json!({ "status": "error", "message": "unknown cmd" }),
    };

    log(&format!("responding: {response}"));
    let result = write_message(&response);
    match &result {
        Ok(()) => log("response written successfully"),
        Err(err) => log(&format!("write_message failed: {err}")),
    }
    result
}

// Mirrors lsp-host's native_messaging::handle_start — the extension needs
// both the port AND the token in one round trip to connect without ever
// showing the user a manual port/token form, and a freshly spawned process
// needs a moment to actually bind its listener before that port is usable,
// so "started" only returns once the health check confirms it's up (or the
// startup timeout elapses).
fn handle_start() -> serde_json::Value {
    let cfg = match config::load_or_create() {
        Ok(cfg) => cfg,
        Err(err) => {
            log(&format!("config::load_or_create() failed: {err}"));
            return serde_json::json!({ "status": "error", "message": err.to_string() });
        }
    };

    if let Some(port) = find_listening_port() {
        log(&format!("already listening on port {port}"));
        return serde_json::json!({ "status": "already_running", "port": port, "token": cfg.token });
    }

    match spawn_detached() {
        Ok(()) => {
            log("spawn_detached() succeeded");
            match wait_for_listening_port() {
                Some(port) => {
                    log(&format!("terminal-host is listening on port {port}"));
                    serde_json::json!({ "status": "started", "port": port, "token": cfg.token })
                }
                None => serde_json::json!({
                    "status": "error",
                    "message": "terminal-hostは起動しましたが、loopbackポートのlistenを確認できませんでした"
                }),
            }
        }
        Err(err) => {
            log(&format!("spawn_detached() failed: {err}"));
            serde_json::json!({ "status": "error", "message": err.to_string() })
        }
    }
}

fn is_terminal_host_port(port: u16) -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    if Write::write_all(
        &mut stream,
        b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .is_err()
    {
        return false;
    }

    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    response.starts_with("HTTP/1.1 200") && response.contains(HEALTH_RESPONSE)
}

fn find_listening_port() -> Option<u16> {
    std::iter::once(config::DEFAULT_PORT)
        .chain(config::PORT_FALLBACKS)
        .find(|port| is_terminal_host_port(*port))
}

fn wait_for_listening_port() -> Option<u16> {
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(port) = find_listening_port() {
            return Some(port);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
fn spawn_detached() -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

    let exe = std::env::current_exe()?;
    let launch_dir = exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("terminal-host.exe has no parent directory"))?;

    std::process::Command::new(&exe)
        .current_dir(launch_dir)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_detached() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let launch_dir = exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("terminal-host has no parent directory"))?;

    std::process::Command::new(&exe)
        .current_dir(launch_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

fn read_message() -> anyhow::Result<Option<serde_json::Value>> {
    let mut len_buf = [0u8; 4];
    if let Err(err) = io::stdin().read_exact(&mut len_buf) {
        if err.kind() == io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(err.into());
    }
    let len = u32::from_ne_bytes(len_buf) as usize;

    let mut body = vec![0u8; len];
    io::stdin().read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn write_message(value: &serde_json::Value) -> anyhow::Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = (body.len() as u32).to_ne_bytes();

    let mut stdout = io::stdout();
    stdout.write_all(&len)?;
    stdout.write_all(&body)?;
    stdout.flush()?;
    Ok(())
}
