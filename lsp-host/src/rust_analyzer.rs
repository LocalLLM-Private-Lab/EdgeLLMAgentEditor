//! Spawns and owns one language-server process, relaying its
//! `Content-Length`-framed stdio as opaque JSON values — this module has no
//! notion of LSP semantics (methods, ids, capabilities), it's a dumb pipe.
//! Mirrors the reader-thread design of terminal-host/src/pty_session.rs
//! (portable-pty's reader is blocking std::io, same as a child's stdout
//! here, so it can't run on the async executor directly).

use serde_json::Value;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

pub struct LanguageServerSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    suppress_exit_notification: Arc<AtomicBool>,
}

fn read_lsp_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None); // EOF before/within headers
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // blank line ends the header block
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse().ok();
        }
    }
    let len = content_length.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "LSP frame missing Content-Length",
        )
    })?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok(Some(value))
}

fn write_lsp_message<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn is_build_script_crash_line(line: &str) -> (bool, bool) {
    let line = line.to_ascii_lowercase();
    let build_scripts = line.contains("run_build_scripts") || line.contains("build scripts");
    let panic = line.contains("senderror") || line.contains("panicked") || line.contains("panic");
    (build_scripts, panic)
}

impl LanguageServerSession {
    /// Spawns `program` with `root_dir` as its cwd and starts a reader
    /// thread that forwards every LSP frame from stdout as
    /// `ServerMessage::Lsp`. Sends `ProcessExited` once the reader hits EOF
    /// (matching `PtySession`'s "always send something on read-loop exit,
    /// even without a real exit code" convention).
    pub fn spawn(
        program: &std::path::Path,
        args: &[&str],
        root_dir: &std::path::Path,
        language: &str,
        out_tx: UnboundedSender<ServerMessage>,
    ) -> anyhow::Result<Self> {
        let mut command = Command::new(program);
        command.args(args);
        Self::spawn_command(command, root_dir, language, out_tx)
    }

    /// Spawns a preconfigured command while keeping the same LSP stdio
    /// handling as `spawn`. This is used for Windows `.cmd`/`.bat` wrappers,
    /// which must be launched through `cmd.exe`.
    pub fn spawn_command(
        mut command: Command,
        root_dir: &std::path::Path,
        language: &str,
        out_tx: UnboundedSender<ServerMessage>,
    ) -> anyhow::Result<Self> {
        let monitor_build_scripts = language.eq_ignore_ascii_case("rust");
        let mut child = command
            .current_dir(root_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if monitor_build_scripts {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdin handle"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdout handle"))?;
        let stderr = child.stderr.take();

        let language = language.to_string();
        if let Some(stderr) = stderr {
            let stderr_language = language.clone();
            let stderr_tx = out_tx.clone();
            std::thread::spawn(move || {
                let mut saw_build_scripts = false;
                let mut saw_panic = false;
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let (build_scripts, panic) = is_build_script_crash_line(&line);
                    saw_build_scripts |= build_scripts;
                    saw_panic |= panic;
                    if saw_build_scripts && saw_panic {
                        let _ = stderr_tx.send(ServerMessage::RustAnalyzerBuildScriptsCrashed {
                            language: stderr_language,
                        });
                        break;
                    }
                }
            });
        }
        let suppress_exit_notification = Arc::new(AtomicBool::new(false));
        let reader_suppress_exit_notification = suppress_exit_notification.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_lsp_message(&mut reader) {
                    Ok(Some(payload)) => {
                        if out_tx
                            .send(ServerMessage::Lsp {
                                language: language.clone(),
                                payload,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            if !reader_suppress_exit_notification.load(Ordering::Acquire) {
                let _ = out_tx.send(ServerMessage::ProcessExited {
                    language,
                    code: None,
                });
            }
        });

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child,
            suppress_exit_notification,
        })
    }

    pub fn send(&self, payload: &Value) -> anyhow::Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| anyhow::anyhow!("language-server stdin lock poisoned"))?;
        write_lsp_message(&mut *stdin, payload)?;
        Ok(())
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        self.suppress_exit_notification
            .store(true, Ordering::Release);
        self.child.kill()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::is_build_script_crash_line;

    #[test]
    fn detects_build_script_panic_terms() {
        assert_eq!(
            is_build_script_crash_line("thread panicked in run_build_scripts"),
            (true, true)
        );
        assert_eq!(
            is_build_script_crash_line("called Result::unwrap() on SendError"),
            (false, true)
        );
    }

    #[test]
    fn ignores_unrelated_rust_analyzer_output() {
        assert_eq!(
            is_build_script_crash_line("failed to resolve a dependency"),
            (false, false)
        );
    }
}
