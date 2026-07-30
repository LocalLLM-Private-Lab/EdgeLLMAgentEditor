use base64::{Engine as _, engine::general_purpose::STANDARD};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ServerMessage;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    // Split out via `Child::clone_killer()` specifically so `kill()` below
    // can signal the process from this struct's owning thread while the
    // waiter thread (which owns the `Child` itself) is blocked inside its
    // own `wait()` — the two used to share one `Arc<Mutex<Box<dyn Child>>>`,
    // which meant `kill()` had to acquire a lock the waiter thread held for
    // as long as the shell was alive, i.e. exactly until the kill it was
    // trying to deliver. That deadlocked `kill()` forever for any session
    // with a live child, which in turn blocked the connection-close cleanup
    // loop in ws_server.rs from ever reaching the point where it decrements
    // `active_connections` — so terminal-host.exe never noticed the last
    // client was gone and never exited on its own.
    killer: Box<dyn ChildKiller + Send + Sync>,
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

/// Used whenever `OpenSession.cwd` is absent or invalid on this machine —
/// the common case is still that the extension has no real OS path to send
/// at all (there is no browser API that exposes one for a File System
/// Access handle, by deliberate design — see docs/protocol.md), so the
/// expected usage remains launching this host from within the project
/// folder itself, its own launch directory already being the right cwd
/// with zero prompting. (The extension *can* send an explicit `cwd` once
/// the workspace's real OS path has been registered — see
/// extension/src/editor/state/workspaceStore.ts's `setWorkspaceRealPath`
/// and `.m365ce/config` — but that path is only as fresh as whenever it
/// was registered; see the cwd fallback in `spawn` below.) Falls back to
/// the system drive root only if the launch directory can't be read.
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
        // `cwd` (when present) came from the workspace's own `.m365ce/config`
        // marker, which is a plain file living inside the opened project
        // folder — if that folder was ever copied (not git-cloned; the
        // marker is gitignored) to a different machine, or just moved, the
        // path it records can point at a directory that no longer exists
        // here. Spawning straight into a dead cwd fails the whole session
        // with no PTY at all, so a stale/invalid cwd is treated the same as
        // an absent one rather than failing outright.
        let resolved_cwd = match cwd {
            Some(dir) if std::path::Path::new(&dir).is_dir() => dir,
            _ => default_cwd(),
        };
        cmd.cwd(resolved_cwd);

        let mut child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id().unwrap_or(0);
        let killer = child.clone_killer();

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
        // Owns `child` outright (moved in) rather than sharing it — nothing
        // else needs `wait()`/`try_wait()`, and `kill()` goes through the
        // separately cloned `killer` above instead, so there's no lock for
        // this thread's blocking wait() to hold against it.
        std::thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = out_tx.send(ServerMessage::Exited {
                session_id: session_id.clone(),
                exit_code,
            });
        });

        Ok((
            Self {
                writer,
                master: pair.master,
                killer,
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
        self.killer.kill()?;
        Ok(())
    }
}
