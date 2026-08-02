use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command as BlockingCommand;
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};

use crate::protocol::ServerMessage;

pub struct DebugSession {
    request_tx: mpsc::UnboundedSender<Value>,
    stop_tx: mpsc::UnboundedSender<()>,
}

#[derive(Debug, Clone)]
pub struct AdapterSpec {
    pub command: String,
    pub args: Vec<String>,
    pub transport: String,
    pub port: Option<u16>,
    pub message: String,
}

/// Resolves a DAP adapter in the user's environment and installs the small
/// adapter packages that have a reliable command-line distribution. This is
/// deliberately host-side: the browser cannot inspect PATH or run package
/// managers directly.
pub async fn ensure_adapter(language: String) -> Result<AdapterSpec> {
    tokio::task::spawn_blocking(move || ensure_adapter_blocking(&language))
        .await
        .context("DAPアダプターの導入処理が中断されました")?
}

fn ensure_adapter_blocking(language: &str) -> Result<AdapterSpec> {
    match language.to_ascii_lowercase().as_str() {
        "python" | "py" => ensure_python_adapter(),
        "go" | "golang" => ensure_go_adapter(),
        "cpp" | "c" | "c++" => ensure_cpp_adapter(),
        "javascript" | "typescript" | "js" | "ts" => ensure_js_adapter(),
        "rust" | "rs" => ensure_rust_adapter(),
        "ruby" | "rb" => ensure_ruby_adapter(),
        other => Err(anyhow!(
            "{other} のDAPアダプターは自動導入に未対応です。アダプター実行ファイルを手動指定してください。"
        )),
    }
}

fn command_exists(command: &str) -> bool {
    let lookup = if cfg!(windows) { "where.exe" } else { "which" };
    BlockingCommand::new(lookup)
        .arg(command)
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false)
}

fn run_program(program: &str, args: &[&str]) -> Result<()> {
    let result = BlockingCommand::new(program)
        .args(args)
        .output()
        .with_context(|| format!("{program}を実行できません"))?;
    if result.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    Err(anyhow!(
        "{program} {} に失敗しました{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        }
    ))
}

fn ensure_python_adapter() -> Result<AdapterSpec> {
    let command = if command_exists("python") {
        "python"
    } else if command_exists("py") {
        "py"
    } else {
        return Err(anyhow!(
            "PythonがPATHに見つかりません。Pythonを先にインストールしてください。"
        ));
    };
    let probe = BlockingCommand::new(command)
        .args(["-c", "import debugpy"])
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false);
    if !probe {
        run_program(command, &["-m", "pip", "install", "--user", "debugpy"])?;
    }
    let final_probe = BlockingCommand::new(command)
        .args(["-c", "import debugpy"])
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false);
    if !final_probe {
        return Err(anyhow!(
            "debugpyの導入後もPythonからdebugpyを読み込めません。"
        ));
    }
    Ok(AdapterSpec {
        command: command.to_string(),
        args: vec!["-m".into(), "debugpy.adapter".into()],
        transport: "stdio".into(),
        port: None,
        message: "Python用debugpyを確認しました。".into(),
    })
}

fn ensure_go_adapter() -> Result<AdapterSpec> {
    if command_exists("dlv") {
        return Ok(AdapterSpec {
            command: "dlv".into(),
            args: vec!["dap".into()],
            transport: "stdio".into(),
            port: None,
            message: "Go用Delveを確認しました。".into(),
        });
    }
    if !command_exists("go") {
        return Err(anyhow!(
            "GoがPATHに見つかりません。Goを先にインストールしてください。"
        ));
    }
    run_program(
        "go",
        &["install", "github.com/go-delve/delve/cmd/dlv@latest"],
    )?;
    let installed = go_binary_path("dlv");
    if !installed.exists() {
        return Err(anyhow!(
            "Delveを導入しましたが、実行ファイルを見つけられません。GOBINまたはGOPATH/binを確認してください。"
        ));
    }
    Ok(AdapterSpec {
        command: installed.to_string_lossy().into_owned(),
        args: vec!["dap".into()],
        transport: "stdio".into(),
        port: None,
        message: "Go用Delveを導入しました。".into(),
    })
}

fn go_binary_path(name: &str) -> PathBuf {
    let gobin = BlockingCommand::new("go")
        .args(["env", "GOBIN"])
        .output()
        .ok()
        .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_string())
        .unwrap_or_default();
    let root = if gobin.is_empty() {
        BlockingCommand::new("go")
            .args(["env", "GOPATH"])
            .output()
            .ok()
            .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_string())
            .unwrap_or_default()
    } else {
        gobin
    };
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    PathBuf::from(root).join(if name.ends_with(suffix) {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    })
}

fn ensure_cpp_adapter() -> Result<AdapterSpec> {
    for command in ["lldb-dap", "lldb-vscode", "OpenDebugAD7"] {
        if command_exists(command) {
            return Ok(AdapterSpec {
                command: command.into(),
                args: Vec::new(),
                transport: "stdio".into(),
                port: None,
                message: format!("C/C++用{command}を確認しました。"),
            });
        }
    }
    Err(anyhow!(
        "C/C++用DAPアダプター(lldb-dap等)が見つかりません。自動導入は環境依存のため、実行ファイルを手動指定してください。"
    ))
}

fn ensure_js_adapter() -> Result<AdapterSpec> {
    let Some(server) = find_js_debug_server() else {
        return Err(anyhow!(
            "JavaScript/TypeScript用js-debugが見つかりません。VS Code系エディタをインストールするか、DAPアダプターを手動指定してください。"
        ));
    };
    if !command_exists("node") {
        return Err(anyhow!(
            "js-debugは見つかりましたが、Node.jsがPATHにありません。"
        ));
    }
    Ok(AdapterSpec {
        command: "node".into(),
        args: vec![server.to_string_lossy().into_owned()],
        transport: "stdio".into(),
        port: None,
        message: "JavaScript/TypeScript用js-debugを検出しました。".into(),
    })
}

fn find_js_debug_server() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Ok(root) = std::env::var(variable) {
            for name in [
                "Microsoft VS Code",
                "Microsoft VS Code Insiders",
                "VSCodium",
            ] {
                candidates.push(PathBuf::from(&root).join(name));
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        for name in [".vscode", ".vscode-insiders"] {
            let root = PathBuf::from(&home).join(name).join("extensions");
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("ms-vscode.js-debug")
                    {
                        candidates.push(entry.path());
                    }
                }
            }
        }
    }
    if let Ok(output) = BlockingCommand::new(if cfg!(windows) { "where.exe" } else { "which" })
        .arg("code")
        .output()
    {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let path = PathBuf::from(line.trim());
            for ancestor in path.ancestors().take(5) {
                candidates.push(ancestor.to_path_buf());
            }
        }
    }
    candidates
        .into_iter()
        .map(|root| {
            root.join("resources/app/extensions/ms-vscode.js-debug/out/src/vsDebugServer.js")
        })
        .find(|path| path.is_file())
}

fn ensure_rust_adapter() -> Result<AdapterSpec> {
    if let Some(codelldb) = find_vscode_lldb_adapter() {
        return codelldb_spec(codelldb.to_string_lossy().into_owned());
    }
    let mut candidates = vec!["codelldb", "lldb-dap", "lldb-vscode", "rust-lldb"];
    if cfg!(windows) {
        candidates.push("OpenDebugAD7");
    }
    for command in candidates {
        if command_exists(command) {
            if command == "rust-lldb" {
                return Err(anyhow!(
                    "rust-lldbはLLDB CLIでありDAPアダプターではありません。codelldbまたはlldb-dapを指定してください。"
                ));
            }
            if command == "codelldb" {
                return codelldb_spec(command.into());
            }
            return Ok(AdapterSpec {
                command: command.into(),
                args: Vec::new(),
                transport: "stdio".into(),
                port: None,
                message: format!("Rust用{command}を検出しました。"),
            });
        }
    }
    Err(anyhow!(
        "Rust用CodeLLDB/lldb-dapが見つかりません。CodeLLDBを導入するか、DAPアダプターを手動指定してください。"
    ))
}

fn codelldb_spec(command: String) -> Result<AdapterSpec> {
    let port = free_tcp_port()?;
    Ok(AdapterSpec {
        command,
        // CodeLLDB is a TCP DAP server. Starting it without --port makes it
        // print "Either --connect or --port must be specified" and exit.
        args: vec!["--port".into(), port.to_string()],
        transport: "tcp".into(),
        port: Some(port),
        message: format!("CodeLLDBをTCPポート{port}で起動します。"),
    })
}

fn find_vscode_lldb_adapter() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let mut roots = Vec::new();
    for directory in [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor"] {
        roots.push(PathBuf::from(&home).join(directory).join("extensions"));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        roots.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Microsoft VS Code")
                .join("resources")
                .join("app")
                .join("extensions"),
        );
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with("vadimcn.vscode-lldb")
            {
                continue;
            }
            let directory = entry.path().join("adapter");
            for name in ["codelldb.exe", "codelldb"] {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn ensure_ruby_adapter() -> Result<AdapterSpec> {
    if !command_exists("ruby") {
        return Err(anyhow!(
            "RubyがPATHに見つかりません。Rubyを先にインストールしてください。"
        ));
    }
    let installed = BlockingCommand::new("ruby")
        .args(["-e", "require 'readapt'"])
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false);
    if !installed {
        run_program(
            "gem",
            &["install", "--user-install", "--no-document", "readapt"],
        )?;
    }
    let verified = BlockingCommand::new("ruby")
        .args(["-e", "require 'readapt'"])
        .output()
        .map(|result| result.status.success())
        .unwrap_or(false);
    if !verified {
        return Err(anyhow!(
            "readaptの導入後もRubyからreadaptを読み込めません。"
        ));
    }
    let port = free_tcp_port()?;
    Ok(AdapterSpec {
        command: "ruby".into(),
        args: vec![
            "-S".into(),
            "readapt".into(),
            "serve".into(),
            "--port".into(),
            port.to_string(),
        ],
        transport: "tcp".into(),
        port: Some(port),
        message: "Ruby用readaptを確認しました。".into(),
    })
}

fn free_tcp_port() -> Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

impl DebugSession {
    pub fn send(&self, message: Value) -> Result<()> {
        self.request_tx
            .send(message)
            .map_err(|_| anyhow!("デバッグアダプターが終了しています"))
    }

    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
    }
}

pub fn spawn(
    adapter_command: String,
    adapter_args: Vec<String>,
    adapter_transport: String,
    adapter_port: Option<u16>,
    cwd: Option<String>,
    session_id: String,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
) -> Result<(DebugSession, u32)> {
    if adapter_command.trim().is_empty() {
        return Err(anyhow!("デバッグアダプターの実行ファイルが未設定です"));
    }

    let mut effective_args = adapter_args;
    let mut effective_transport = adapter_transport;
    let mut effective_port = adapter_port;
    if is_codelldb_command(&adapter_command)
        && effective_transport == "stdio"
        && !effective_args
            .iter()
            .any(|arg| arg == "--connect" || arg == "--port")
    {
        let port = free_tcp_port()?;
        effective_args.extend(["--port".into(), port.to_string()]);
        effective_transport = "tcp".into();
        effective_port = Some(port);
    }

    let mut command = Command::new(&adapter_command);
    command.args(effective_args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let is_tcp = effective_transport == "tcp";
    let mut child = command
        .stdin(if is_tcp {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(if is_tcp {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("デバッグアダプターを起動できません: {adapter_command}"))?;
    let pid = child
        .id()
        .ok_or_else(|| anyhow!("デバッグアダプターのプロセスIDを取得できません"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("デバッグアダプターのエラー出力を開けません"))?;

    let (request_tx, request_rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = mpsc::unbounded_channel();
    let task_session_id = session_id.clone();
    tokio::spawn(async move {
        if is_tcp {
            run_tcp_adapter(
                child,
                stderr,
                effective_port,
                request_rx,
                stop_rx,
                task_session_id,
                out_tx,
            )
            .await;
        } else {
            let Some(stdin) = child.stdin.take() else {
                let _ = out_tx.send(ServerMessage::DebugError {
                    session_id: task_session_id,
                    message: "デバッグアダプターの入力を開けません".into(),
                });
                return;
            };
            let Some(stdout) = child.stdout.take() else {
                let _ = out_tx.send(ServerMessage::DebugError {
                    session_id: task_session_id,
                    message: "デバッグアダプターの出力を開けません".into(),
                });
                return;
            };
            run_adapter(
                child,
                stdin,
                stdout,
                stderr,
                AdapterRuntime {
                    request_rx,
                    stop_rx,
                    session_id: task_session_id,
                    out_tx,
                },
            )
            .await;
        }
    });

    Ok((
        DebugSession {
            request_tx,
            stop_tx,
        },
        pid,
    ))
}

fn is_codelldb_command(command: &str) -> bool {
    std::path::Path::new(command)
        .file_stem()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("codelldb"))
}

async fn run_tcp_adapter(
    mut child: Child,
    stderr: impl AsyncRead + Unpin + Send + 'static,
    port: Option<u16>,
    request_rx: mpsc::UnboundedReceiver<Value>,
    mut stop_rx: mpsc::UnboundedReceiver<()>,
    session_id: String,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
) {
    let Some(port) = port else {
        let _ = out_tx.send(ServerMessage::DebugError {
            session_id,
            message: "TCP型DAPアダプターのポートが未指定です".into(),
        });
        let _ = child.kill().await;
        return;
    };
    let stream = {
        let mut connected = None;
        for _ in 0..100 {
            match TcpStream::connect(("127.0.0.1", port)).await {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(_) => sleep(Duration::from_millis(100)).await,
            }
        }
        connected
    };
    let Some(stream) = stream else {
        let _ = out_tx.send(ServerMessage::DebugError {
            session_id: session_id.clone(),
            message: format!("DAPアダプター(127.0.0.1:{port})へ接続できません"),
        });
        let _ = child.kill().await;
        let _ = out_tx.send(ServerMessage::DebugExited {
            session_id,
            exit_code: None,
        });
        return;
    };
    let (reader_stream, mut writer_stream) = stream.into_split();
    let reader_session_id = session_id.clone();
    let reader_out_tx = out_tx.clone();
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(reader_stream);
        loop {
            match read_dap_message(&mut reader).await {
                Ok(Some(message)) => {
                    let _ = reader_out_tx.send(ServerMessage::DebugMessage {
                        session_id: reader_session_id.clone(),
                        message,
                    });
                }
                Ok(None) => break,
                Err(err) => {
                    let _ = reader_out_tx.send(ServerMessage::DebugError {
                        session_id: reader_session_id.clone(),
                        message: format!("DAP受信エラー: {err}"),
                    });
                    break;
                }
            }
        }
    });
    let writer_task = tokio::spawn(async move {
        let mut request_rx = request_rx;
        while let Some(message) = request_rx.recv().await {
            if write_dap_message(&mut writer_stream, &message)
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let stderr_session_id = session_id.clone();
    let stderr_out_tx = out_tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
            let _ = stderr_out_tx.send(ServerMessage::DebugOutput {
                session_id: stderr_session_id.clone(),
                data: line.trim_end_matches(['\r', '\n']).to_string(),
            });
            line.clear();
        }
    });
    let exit_code = tokio::select! {
        result = child.wait() => result.ok().and_then(|status| status.code()),
        _ = stop_rx.recv() => { let _ = child.kill().await; child.wait().await.ok().and_then(|status| status.code()) }
    };
    writer_task.abort();
    reader_task.abort();
    stderr_task.abort();
    let _ = out_tx.send(ServerMessage::DebugExited {
        session_id,
        exit_code,
    });
}

struct AdapterRuntime {
    request_rx: mpsc::UnboundedReceiver<Value>,
    stop_rx: mpsc::UnboundedReceiver<()>,
    session_id: String,
    out_tx: mpsc::UnboundedSender<ServerMessage>,
}

async fn run_adapter<R: AsyncRead + Unpin + Send + 'static>(
    mut child: Child,
    mut stdin: ChildStdin,
    stdout: R,
    stderr: impl AsyncRead + Unpin + Send + 'static,
    runtime: AdapterRuntime,
) {
    let AdapterRuntime {
        mut request_rx,
        mut stop_rx,
        session_id,
        out_tx,
    } = runtime;
    let reader_session_id = session_id.clone();
    let reader_out_tx = out_tx.clone();
    let reader_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_dap_message(&mut reader).await {
                Ok(Some(message)) => {
                    let _ = reader_out_tx.send(ServerMessage::DebugMessage {
                        session_id: reader_session_id.clone(),
                        message,
                    });
                }
                Ok(None) => break,
                Err(err) => {
                    let _ = reader_out_tx.send(ServerMessage::DebugError {
                        session_id: reader_session_id.clone(),
                        message: format!("DAP受信エラー: {err}"),
                    });
                    break;
                }
            }
        }
    });

    let stderr_session_id = session_id.clone();
    let stderr_out_tx = out_tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let _ = stderr_out_tx.send(ServerMessage::DebugOutput {
                        session_id: stderr_session_id.clone(),
                        data: line.trim_end_matches(['\r', '\n']).to_string(),
                    });
                }
                Err(err) => {
                    let _ = stderr_out_tx.send(ServerMessage::DebugError {
                        session_id: stderr_session_id.clone(),
                        message: format!("デバッグアダプターのエラー出力を読めません: {err}"),
                    });
                    break;
                }
            }
        }
    });

    let writer_task = tokio::spawn(async move {
        while let Some(message) = request_rx.recv().await {
            write_dap_message(&mut stdin, &message).await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let exit_code = tokio::select! {
        result = child.wait() => result.ok().and_then(|status| status.code()),
        _ = stop_rx.recv() => {
            let _ = child.kill().await;
            child.wait().await.ok().and_then(|status| status.code())
        }
    };

    writer_task.abort();
    reader_task.abort();
    stderr_task.abort();
    let _ = out_tx.send(ServerMessage::DebugExited {
        session_id,
        exit_code,
    });
}

async fn write_dap_message<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    message: &Value,
) -> Result<()> {
    let body = serde_json::to_vec(message).context("DAPメッセージをJSON化できません")?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_dap_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).await?;
        if bytes == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                value
                    .trim()
                    .parse()
                    .context("DAP Content-Lengthが不正です")?,
            );
        }
    }

    let length = content_length.ok_or_else(|| anyhow!("DAP Content-Lengthがありません"))?;
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(
        serde_json::from_slice(&body).context("DAPメッセージが不正なJSONです")?,
    ))
}
