/** Reads the real absolute OS path of an opened workspace, if terminal-host
 * has ever been launched from within it — see
 * terminal-host/src/main.rs's `write_workspace_marker`, which drops
 * `.m365ce/config` (`{"workspaceRealPath": "<cwd>"}`) into its own launch
 * directory. The File System Access API itself has no way to expose a real
 * OS path for a handle (by deliberate browser design, see
 * docs/protocol.md) — this is the one workaround: a plain file *inside*
 * the workspace whose *contents* the browser can read even though the
 * *handle* can't tell it where on disk it lives.
 *
 * Best-effort only: returns null (not a thrown error) whenever the marker
 * is absent, unreadable, or malformed — most workspaces will never have
 * been opened as a terminal-host launch directory at all. */
export async function readWorkspaceRealPath(rootHandle: FileSystemDirectoryHandle): Promise<string | null> {
  try {
    const markerDir = await rootHandle.getDirectoryHandle('.m365ce');
    const configHandle = await markerDir.getFileHandle('config');
    const file = await configHandle.getFile();
    const parsed: unknown = JSON.parse(await file.text());
    const value = (parsed as { workspaceRealPath?: unknown } | null)?.workspaceRealPath;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}
