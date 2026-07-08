/** Builds a path for a file relative to the workspace root, using Windows
 * separators. Passed as-is to run commands (e.g. `python {file}`) — since
 * terminal-host opens sessions with its own launch directory as cwd (see
 * pty_session.rs's default_cwd), and that's expected to be the same
 * project folder, a relative path resolves correctly without ever needing
 * a real absolute path (which the File System Access API can't expose
 * anyway — see docs/protocol.md). */
export function resolveRelativeFilePath(pathSegments: string[]): string {
  return pathSegments.join('\\');
}
