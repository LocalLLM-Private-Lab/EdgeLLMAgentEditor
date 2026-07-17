mod auth;
mod config;
mod fetch;
mod native_messaging;
mod protocol;
mod rust_analyzer;
mod ws_server;

use std::net::SocketAddr;

// Same extension as terminal-host — pinned via extension/.dev-keys —
// regenerate both hosts' copies together if the extension's dev signing key
// is regenerated.
const EXPECTED_EXTENSION_ID: &str = "fehlbbjdbgjgjnbgjnhcehkdgnlagboo";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("lsp-host-native-messaging.log"))
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "main() launched with args: {args:?}")
        });

    // Same dispatch convention as terminal-host/src/main.rs: the browser
    // invokes a registered Native Messaging host with the calling
    // extension's origin as argv[1].
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

    println!("EdgeLLMAgentEditor - LSP host");
    println!("  listening on ws://127.0.0.1:{port}/ws");
    println!("  token: {}", cfg.token);
    println!();
    println!("  Rust workspace root will be: {cwd}");
    println!("  (this process's own launch directory — run lsp-host.exe from inside");
    println!("   your Rust project's root folder, same convention as terminal-host)");

    axum::serve(listener, app).await?;
    Ok(())
}
