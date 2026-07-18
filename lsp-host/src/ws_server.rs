use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, mpsc};

use crate::auth::is_authorized;
use crate::config::HostConfig;
use crate::fetch;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::rust_analyzer::LanguageServerSession;

#[derive(Clone)]
pub struct AppState {
    pub config: HostConfig,
    pub expected_origin: String,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_authorized(&headers, &state.expected_origin, &state.config.token) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let token = state.config.token.clone();
    ws.protocols([token]).on_upgrade(handle_socket)
}

/// `dir` as a `file:///`-prefixed URI, built with the `url` crate rather
/// than a hand-rolled string (percent-encoding spaces/special characters
/// correctly — a workspace path like `C:\Users\John Doe\project` needs
/// `%20`, not a literal space). Windows drive-letter casing may still not
/// byte-match server responses; the browser compares URI keys
/// case-insensitively for that reason.
fn root_uri(dir: &Path) -> String {
    url::Url::from_file_path(dir)
        .map(|u| u.to_string())
        .unwrap_or_else(|()| {
            let normalized = dir.to_string_lossy().replace('\\', "/");
            format!("file:///{}", normalized.trim_start_matches('/'))
        })
}

fn default_root_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

struct ActiveSession {
    server: LanguageServerSession,
    root_dir: PathBuf,
}

#[derive(Clone, Copy)]
enum AutoInstall {
    Npm {
        packages: &'static [&'static str],
        executable: &'static str,
    },
    Gem {
        package: &'static str,
        executable: &'static str,
    },
    Clangd,
}

#[derive(Clone, Copy)]
struct ExternalServerCandidate {
    program: &'static str,
    args: &'static [&'static str],
    auto_install: Option<AutoInstall>,
}

const EMPTY_ARGS: &[&str] = &[];
const STDIO_ARGS: &[&str] = &["--stdio"];
const SOLARGRAPH_ARGS: &[&str] = &["stdio"];
const PYRIGHT_PACKAGES: &[&str] = &["pyright"];
const WEB_PACKAGES: &[&str] = &["vscode-langservers-extracted"];
const TYPESCRIPT_PACKAGES: &[&str] = &["typescript", "typescript-language-server"];

// Package-manager operations are serialized because npm and RubyGems both
// update shared user-level metadata. Separate language sessions can still
// run concurrently once their servers are installed.
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn install_lock() -> &'static Mutex<()> {
    INSTALL_LOCK.get_or_init(|| Mutex::new(()))
}

/// Returns the external executable candidates for a language. The `.cmd`
/// variants are important on Windows because npm global binaries are command
/// files rather than native executables; `resolve_program` handles them via
/// cmd.exe after locating them on PATH.
fn external_server_candidates(language: &str) -> Vec<ExternalServerCandidate> {
    match language {
        "c" | "cpp" => vec![ExternalServerCandidate {
            program: "clangd",
            args: EMPTY_ARGS,
            auto_install: Some(AutoInstall::Clangd),
        }],
        "python" => vec![
            ExternalServerCandidate {
                program: "pyright-langserver",
                args: STDIO_ARGS,
                auto_install: Some(AutoInstall::Npm {
                    packages: PYRIGHT_PACKAGES,
                    executable: "pyright-langserver",
                }),
            },
            ExternalServerCandidate {
                program: "pylsp",
                args: EMPTY_ARGS,
                auto_install: None,
            },
        ],
        "ruby" => vec![
            ExternalServerCandidate {
                program: "solargraph",
                args: SOLARGRAPH_ARGS,
                auto_install: Some(AutoInstall::Gem {
                    package: "solargraph",
                    executable: "solargraph",
                }),
            },
            ExternalServerCandidate {
                program: "ruby-lsp",
                args: EMPTY_ARGS,
                auto_install: Some(AutoInstall::Gem {
                    package: "ruby-lsp",
                    executable: "ruby-lsp",
                }),
            },
        ],
        "html" => vec![ExternalServerCandidate {
            program: "vscode-html-language-server",
            args: STDIO_ARGS,
            auto_install: Some(AutoInstall::Npm {
                packages: WEB_PACKAGES,
                executable: "vscode-html-language-server",
            }),
        }],
        "css" => vec![ExternalServerCandidate {
            program: "vscode-css-language-server",
            args: STDIO_ARGS,
            auto_install: Some(AutoInstall::Npm {
                packages: WEB_PACKAGES,
                executable: "vscode-css-language-server",
            }),
        }],
        "javascript" | "typescript" => vec![ExternalServerCandidate {
            program: "typescript-language-server",
            args: STDIO_ARGS,
            auto_install: Some(AutoInstall::Npm {
                packages: TYPESCRIPT_PACKAGES,
                executable: "typescript-language-server",
            }),
        }],
        _ => vec![],
    }
}

fn resolve_program(program: &str) -> anyhow::Result<PathBuf> {
    let lookup = if cfg!(windows) { "where.exe" } else { "which" };
    let output = Command::new(lookup).arg(program).output()?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let path = stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from);
        if let Some(path) = path {
            return Ok(path);
        }
    }

    if cfg!(windows) && program == "clangd" {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let path = PathBuf::from(program_files)
                .join("LLVM")
                .join("bin")
                .join("clangd.exe");
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    anyhow::bail!("executable not found on PATH: {program}")
}

fn npm_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("EdgeLLMAgentEditor")
        .join("lsp-host")
        .join("servers")
        .join("npm")
}

fn npm_bin_path(executable: &str) -> PathBuf {
    let suffix = if cfg!(windows) { ".cmd" } else { "" };
    npm_root()
        .join("node_modules")
        .join(".bin")
        .join(format!("{executable}{suffix}"))
}

fn quote_command_arg(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|ch| !ch.is_whitespace() && !matches!(ch, '"' | '&' | '|' | '<' | '>' | '^'))
    {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

fn run_program(
    resolved: &Path,
    args: &[String],
    current_dir: Option<&Path>,
) -> anyhow::Result<std::process::Output> {
    let is_cmd = resolved
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));

    let mut command;
    if is_cmd {
        let mut command_line = quote_command_arg(&resolved.to_string_lossy());
        for arg in args {
            command_line.push(' ');
            command_line.push_str(&quote_command_arg(arg));
        }
        command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", &command_line]);
    } else {
        command = Command::new(resolved);
        command.args(args);
    }

    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(
            "command exited with {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }
    Ok(output)
}

fn gem_user_bin(executable: &str) -> anyhow::Result<PathBuf> {
    let gem = resolve_program("gem")?;
    let output = run_program(&gem, &["env".into(), "user_gemhome".into()], None)?;
    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if home.is_empty() {
        anyhow::bail!("RubyGems did not return a user gem home")
    }
    let suffix = if cfg!(windows) { ".bat" } else { "" };
    Ok(PathBuf::from(home)
        .join("bin")
        .join(format!("{executable}{suffix}")))
}

fn auto_install_description(spec: AutoInstall) -> String {
    match spec {
        AutoInstall::Npm { packages, .. } => {
            format!("npmで {} をユーザー領域へ導入中", packages.join(", "))
        }
        AutoInstall::Gem { package, .. } => format!("RubyGemsで {package} をユーザー領域へ導入中"),
        AutoInstall::Clangd => "clangdを利用可能なOSパッケージマネージャーから導入中".into(),
    }
}

fn installed_program(spec: AutoInstall) -> anyhow::Result<PathBuf> {
    match spec {
        AutoInstall::Npm { executable, .. } => {
            let local = npm_bin_path(executable);
            if local.is_file() {
                return Ok(local);
            }
            resolve_program(executable)
        }
        AutoInstall::Gem { executable, .. } => {
            if let Ok(local) = gem_user_bin(executable)
                && local.is_file()
            {
                return Ok(local);
            }
            resolve_program(executable)
        }
        AutoInstall::Clangd => resolve_program("clangd"),
    }
}

fn install_npm(packages: &'static [&'static str]) -> anyhow::Result<()> {
    let npm = resolve_program("npm")?;
    std::fs::create_dir_all(npm_root())?;
    let mut args = vec![
        "install".to_string(),
        "--prefix".to_string(),
        npm_root().to_string_lossy().into_owned(),
        "--no-package-lock".to_string(),
        "--no-save".to_string(),
    ];
    args.extend(packages.iter().map(|package| (*package).to_string()));
    run_program(&npm, &args, None)?;
    Ok(())
}

fn install_gem(package: &'static str) -> anyhow::Result<()> {
    let gem = resolve_program("gem")?;
    run_program(
        &gem,
        &[
            "install".into(),
            "--user-install".into(),
            "--no-document".into(),
            package.into(),
        ],
        None,
    )?;
    Ok(())
}

fn install_clangd() -> anyhow::Result<()> {
    let managers: Vec<(&str, Vec<String>)> = if cfg!(windows) {
        vec![
            (
                "winget",
                vec![
                    "install".into(),
                    "--id".into(),
                    "LLVM.LLVM".into(),
                    "--exact".into(),
                    "--accept-source-agreements".into(),
                    "--accept-package-agreements".into(),
                ],
            ),
            ("scoop", vec!["install".into(), "llvm".into()]),
            ("choco", vec!["install".into(), "llvm".into(), "-y".into()]),
        ]
    } else if cfg!(target_os = "macos") {
        vec![("brew", vec!["install".into(), "llvm".into()])]
    } else {
        Vec::new()
    };

    let mut errors = Vec::new();
    for (manager, args) in managers {
        let Ok(program) = resolve_program(manager) else {
            continue;
        };
        match run_program(&program, &args, None) {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(format!("{manager}: {err}")),
        }
    }

    if cfg!(target_os = "linux") {
        anyhow::bail!("clangdが見つかりません。apt/dnf/pacman等でclangdを導入してください")
    }
    anyhow::bail!(
        "clangdを自動導入できません。winget/scoop/choco(Windows)またはbrew(macOS)を用意してください。{}",
        if errors.is_empty() {
            String::new()
        } else {
            format!(" {}", errors.join("; "))
        }
    )
}

fn install_auto(spec: AutoInstall) -> anyhow::Result<()> {
    match spec {
        AutoInstall::Npm { packages, .. } => install_npm(packages),
        AutoInstall::Gem { package, .. } => install_gem(package),
        AutoInstall::Clangd => install_clangd(),
    }
}

fn spawn_resolved_server(
    resolved: &Path,
    args: &[&str],
    root_dir: &Path,
    language: &str,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
) -> anyhow::Result<LanguageServerSession> {
    let is_cmd = resolved
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));

    if !is_cmd {
        return LanguageServerSession::spawn(resolved, args, root_dir, language, out_tx);
    }

    let mut command_line = format!("\"{}\"", resolved.display());
    if !args.is_empty() {
        command_line.push(' ');
        command_line.push_str(&args.join(" "));
    }
    let shell_args = ["/d", "/s", "/c", command_line.as_str()];
    LanguageServerSession::spawn(
        Path::new("cmd.exe"),
        &shell_args,
        root_dir,
        language,
        out_tx,
    )
}

fn spawn_external_server(
    program: &str,
    args: &[&str],
    root_dir: &Path,
    language: &str,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
) -> anyhow::Result<LanguageServerSession> {
    let resolved = resolve_program(program)?;
    spawn_resolved_server(&resolved, args, root_dir, language, out_tx)
}

async fn ensure_language_server_session(
    out_tx: mpsc::UnboundedSender<ServerMessage>,
    root_dir: PathBuf,
    language: &str,
) -> anyhow::Result<LanguageServerSession> {
    if language == "rust" {
        let exe_path = if let Some(cached) = fetch::find_cached_exe() {
            cached
        } else {
            let progress_tx = out_tx.clone();
            fetch::ensure_rust_analyzer(move |downloaded, total| {
                let _ = progress_tx.send(ServerMessage::FetchProgress { downloaded, total });
            })
            .await?
        };
        return LanguageServerSession::spawn(&exe_path, &[], &root_dir, language, out_tx);
    }

    let candidates = external_server_candidates(language);
    if candidates.is_empty() {
        anyhow::bail!("unsupported language: {language}");
    }
    let mut errors = Vec::new();
    for candidate in candidates.iter().copied() {
        match spawn_external_server(
            candidate.program,
            candidate.args,
            &root_dir,
            language,
            out_tx.clone(),
        ) {
            Ok(server) => return Ok(server),
            Err(err) => errors.push(format!("{}: {err}", candidate.program)),
        }
    }

    let installable = candidates
        .iter()
        .copied()
        .filter_map(|candidate| candidate.auto_install.map(|spec| (candidate, spec)))
        .collect::<Vec<_>>();
    if !installable.is_empty() {
        let _install_guard = install_lock().lock().await;
        for (candidate, spec) in installable {
            if let Ok(program) = installed_program(spec)
                && let Ok(server) = spawn_resolved_server(
                    &program,
                    candidate.args,
                    &root_dir,
                    language,
                    out_tx.clone(),
                )
            {
                return Ok(server);
            }

            let _ = out_tx.send(ServerMessage::InstallProgress {
                language: language.to_string(),
                message: auto_install_description(spec),
            });
            let result = tokio::task::spawn_blocking(move || install_auto(spec)).await?;
            match result {
                Ok(()) => {
                    let program = installed_program(spec).map_err(|err| {
                        anyhow::anyhow!(
                            "インストール後に{}を見つけられません: {err}",
                            candidate.program
                        )
                    })?;
                    match spawn_resolved_server(
                        &program,
                        candidate.args,
                        &root_dir,
                        language,
                        out_tx.clone(),
                    ) {
                        Ok(server) => return Ok(server),
                        Err(err) => errors.push(format!("{}: {err}", candidate.program)),
                    }
                }
                Err(err) => errors.push(format!("自動導入: {err}")),
            }
        }
    }
    anyhow::bail!(
        "No language server found for {language}. PATH上のサーバーを導入するか、自動導入に必要なパッケージマネージャーを用意してください. {}",
        errors.join("; ")
    )
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let Ok(json) = serde_json::to_string(&msg) else {
                continue;
            };
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    // One WebSocket now multiplexes one language server per language. This
    // lets a project keep Rust, Python, C++ and web files open at once while
    // preserving the opaque LSP JSON-RPC payload design.
    let sessions: Arc<Mutex<HashMap<String, ActiveSession>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some(Ok(msg)) = ws_rx.next().await {
        let Message::Text(text) = msg else { continue };
        let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
        let Ok(client_msg) = parsed else {
            let _ = out_tx.send(ServerMessage::Error {
                message: "invalid message".into(),
            });
            continue;
        };

        match client_msg {
            ClientMessage::OpenSession {
                language,
                workspace_root,
            } => {
                if language != "rust" && external_server_candidates(&language).is_empty() {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("unsupported language: {language}"),
                    });
                    continue;
                }

                let requested_root = workspace_root
                    .map(PathBuf::from)
                    .unwrap_or_else(default_root_dir);
                if !requested_root.is_dir() {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("フォルダが見つかりません: {}", requested_root.display()),
                    });
                    continue;
                }

                {
                    let mut guard = sessions.lock().await;
                    if let Some(active) = guard.get(&language)
                        && active.root_dir == requested_root
                    {
                        let _ = out_tx.send(ServerMessage::Ready {
                            language,
                            root_uri: root_uri(&active.root_dir),
                        });
                        continue;
                    }

                    // All language sessions share one workspace root. If the
                    // root changes, restart every server so their indexes and
                    // file URIs stay consistent.
                    if guard
                        .values()
                        .any(|active| active.root_dir != requested_root)
                    {
                        for (_, mut active) in guard.drain() {
                            let _ = active.server.kill();
                        }
                    }
                }

                let session_slot = sessions.clone();
                let out_tx2 = out_tx.clone();
                let language_for_task = language.clone();
                tokio::spawn(async move {
                    match ensure_language_server_session(
                        out_tx2.clone(),
                        requested_root.clone(),
                        &language_for_task,
                    )
                    .await
                    {
                        Ok(server) => {
                            let root_uri_str = root_uri(&requested_root);
                            session_slot.lock().await.insert(
                                language_for_task.clone(),
                                ActiveSession {
                                    server,
                                    root_dir: requested_root,
                                },
                            );
                            let _ = out_tx2.send(ServerMessage::Ready {
                                language: language_for_task,
                                root_uri: root_uri_str,
                            });
                        }
                        Err(err) => {
                            let _ = out_tx2.send(ServerMessage::FetchError {
                                message: err.to_string(),
                            });
                        }
                    }
                });
            }
            ClientMessage::Lsp { language, payload } => {
                let guard = sessions.lock().await;
                if let Some(active) = guard.get(&language) {
                    if let Err(err) = active.server.send(&payload) {
                        let _ = out_tx.send(ServerMessage::Error {
                            message: err.to_string(),
                        });
                    }
                } else {
                    let _ = out_tx.send(ServerMessage::Error {
                        message: format!("LSP session is not ready for language: {language}"),
                    });
                }
            }
            ClientMessage::CloseSession => {
                for (_, mut active) in sessions.lock().await.drain() {
                    let _ = active.server.kill();
                }
            }
        }
    }

    for (_, mut active) in sessions.lock().await.drain() {
        let _ = active.server.kill();
    }
    writer_task.abort();
}
