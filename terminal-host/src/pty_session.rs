use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
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

/// The extension never sends a cwd (there is no browser API that exposes
/// a real OS path for a File System Access handle, by deliberate design —
/// see docs/protocol.md). Instead, the expected usage is to launch this
/// host from within the project folder itself, so its own launch
/// directory already *is* the right cwd, with zero prompting. Falls back
/// to the system drive root only if the launch directory can't be read.
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

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

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
            let _ = out_tx.send(ServerMessage::Exited {
                session_id: session_id.clone(),
                exit_code: None,
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
        self.child.kill()?;
        Ok(())
    }
}
