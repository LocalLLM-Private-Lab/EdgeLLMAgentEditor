//! Spawns and owns one language-server process, relaying its
//! `Content-Length`-framed stdio as opaque JSON values — this module has no
//! notion of LSP semantics (methods, ids, capabilities), it's a dumb pipe.
//! Mirrors the reader-thread design of terminal-host/src/pty_session.rs
//! (portable-pty's reader is blocking std::io, same as a child's stdout
//! here, so it can't run on the async executor directly).

use serde_json::Value;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

pub struct LanguageServerSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
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
    let len = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "LSP frame missing Content-Length"))?;
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
        let mut child = Command::new(program)
            .args(args)
            .current_dir(root_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdin handle"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("child has no stdout handle"))?;

        let language = language.to_string();
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
            let _ = out_tx.send(ServerMessage::ProcessExited { language, code: None });
        });

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child,
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
        self.child.kill()?;
        Ok(())
    }
}
