use base64::{Engine as _, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    // Shared with the reader thread, which calls `wait()` on it once it
    // sees EOF so `Exited` can carry the process's real exit code instead
    // of always reporting `None`.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        match which::which("pwsh.exe") {
            Ok(_) => "pwsh.exe".to_string(),
            Err(_) => "powershell.exe".to_string(),
        }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// A 0x0 (or otherwise degenerate) PTY size is untested territory across
/// platforms/ConPTY versions — clamp defensively rather than hand it
/// straight to `openpty`/`resize`. The extension already clamps before
/// sending, but this is the last line of defense for any other caller.
fn clamp_dimension(value: u16) -> u16 {
    value.max(1)
}

/// Used whenever `OpenSession.cwd` is absent — the common case is still
/// that the extension has no real OS path to send at all (there is no
/// browser API that exposes one for a File System Access handle, by
/// deliberate design — see docs/protocol.md), so the expected usage
/// remains launching this host from within the project folder itself, its
/// own launch directory already being the right cwd with zero prompting.
/// (The extension *can* send an explicit `cwd` when it managed to read
/// `.m365ce/config` back out of the open workspace — see
/// `write_workspace_marker` in main.rs and extension/src/editor/fs/
/// workspaceRealPath.ts — but that only covers the workspace that marker
/// was written into.) Falls back to the system drive root only if the
/// launch directory can't be read.
fn default_cwd() -> String {
    if let Ok(dir) = std::env::current_dir() {
        return dir.to_string_lossy().into_owned();
    }
    if cfg!(windows) {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        format!("{drive}\\")
    } else {
        "/".to_string()
    }
}

impl PtySession {
    /// Spawns a PTY-backed shell and a dedicated OS thread that forwards its
    /// output to `out_tx` as base64-encoded `ServerMessage::Stdout` frames
    /// (portable-pty's reader is blocking std::io, so it can't run on the
    /// async executor directly). Sends `Exited` once the reader hits EOF.
    pub fn spawn(
        session_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        out_tx: UnboundedSender<ServerMessage>,
    ) -> anyhow::Result<(Self, u32)> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: clamp_dimension(rows),
            cols: clamp_dimension(cols),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
        cmd.cwd(cwd.unwrap_or_else(default_cwd));

        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id().unwrap_or(0);
        let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Reader thread: relays stdout only. On Windows, ConPTY's pipe does
        // *not* EOF just because the child process exited — it stays open
        // as long as the pseudo-console handle (held by `master`, kept
        // alive in the session map) exists, so `read()` can block forever
        // past the point the shell is already dead. Exit detection is
        // handled entirely by the separate waiter thread below, which
        // waits on the real OS process handle instead.
        {
            let out_tx = out_tx.clone();
            let session_id = session_id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = STANDARD.encode(&buf[..n]);
                            if out_tx
                                .send(ServerMessage::Stdout {
                                    session_id: session_id.clone(),
                                    data,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Waiter thread: the sole source of `Exited`. Blocks on the actual
        // process handle (unaffected by the ConPTY pipe quirk above), so it
        // reliably fires whether the shell exited on its own or was killed.
        let waiter_child = Arc::clone(&child);
        std::thread::spawn(move || {
            let exit_code = waiter_child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .map(|status| status.exit_code() as i32);
            let _ = out_tx.send(ServerMessage::Exited {
                session_id: session_id.clone(),
                exit_code,
            });
        });

        Ok((
            Self {
                writer,
                master: pair.master,
                child,
            },
            pid,
        ))
    }

    pub fn write_stdin(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(PtySize {
            rows: clamp_dimension(rows),
            cols: clamp_dimension(cols),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        self.child
            .lock()
            .map_err(|_| anyhow::anyhow!("child lock poisoned"))?
            .kill()?;
        Ok(())
    }
}
