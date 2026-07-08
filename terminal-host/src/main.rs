mod auth;
mod config;
mod native_messaging;
mod protocol;
mod pty_session;
mod ws_server;

use std::net::SocketAddr;

// Pinned via extension/.dev-keys — regenerate both together if the
// extension's dev signing key is regenerated.
const EXPECTED_EXTENSION_ID: &str = "fehlbbjdbgjgjnbgjnhcehkdgnlagboo";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("terminal-host-native-messaging.log"))
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "main() launched with args: {args:?}")
        });

    // The browser invokes registered Native Messaging hosts with the
    // calling extension's origin as argv[1] (e.g.
    // "chrome-extension://<id>/") — that's how we tell "launched by the
    // extension to start the real server" apart from a normal launch.
    if args
        .get(1)
        .is_some_and(|arg| arg.starts_with("chrome-extension://"))
    {
        return native_messaging::run();
    }

    tracing_subscriber::fmt::init();

    let cfg = config::load_or_create()?;
    let expected_origin = format!("chrome-extension://{EXPECTED_EXTENSION_ID}");

    let ports_to_try: Vec<u16> = std::iter::once(cfg.port)
        .chain(config::PORT_FALLBACKS)
        .collect();

    let (listener, port) = 'bind: {
        for candidate in &ports_to_try {
            let addr = SocketAddr::from(([127, 0, 0, 1], *candidate));
            if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
                break 'bind (listener, *candidate);
            }
        }
        anyhow::bail!("could not bind to any of {ports_to_try:?} on 127.0.0.1");
    };

    let state = ws_server::AppState {
        config: cfg.clone(),
        expected_origin,
    };
    let app = ws_server::build_router(state);

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "?".to_string());

    println!("M365 Copilot Code Editor - terminal host");
    println!("  listening on ws://127.0.0.1:{port}/ws");
    println!("  token: {}", cfg.token);
    println!("  (paste the WebSocket URL and token into the extension's settings panel)");
    println!();
    println!("  new terminals will open in: {cwd}");
    println!("  (this process's own launch directory — cd there yourself in the terminal");
    println!("   if that's not where you want to work, same as any other terminal app)");

    axum::serve(listener, app).await?;
    Ok(())
}
