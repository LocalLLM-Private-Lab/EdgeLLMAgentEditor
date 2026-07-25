import { extensionOf, buildRunCommand, type RunCommandMap } from '../state/runCommandStore';
import type { NamedCommandMap } from '../state/namedCommandStore';
import { resolveRelativeFilePath } from '../terminal/resolveRelativeFilePath';
import { resolveWorkspaceFiles } from './resolveWorkspaceFile';

export type RunToolResolution =
  | { ok: true; path: string; command: string }
  | { ok: false; path: string; message: string };

/** Resolves a Copilot-requested `TOOL_RUN: <path>` against the user's own
 * pre-configured runCommandStore mapping — Copilot can only ever name a
 * workspace-relative path, never a shell command; the actual command that
 * runs always comes from the same trusted extension->template config the
 * manual "実行" button already uses. Kept separate from localTools.ts
 * deliberately: that module's contract is "always safe to auto-run, no
 * confirmation needed" (read-only search/list); this one always requires a
 * real process launch, so callers must show a confirmation step before
 * actually executing the resolved command.
 *
 * `resolveWorkspaceFiles` only matches paths that are literally present in
 * the enumerated workspace file list, so a path-traversal string or an
 * absolute path from Copilot's response simply fails to resolve here —
 * no extra sanitization needed on top of that. */
export async function resolveRunToolRequest(
  rootHandle: FileSystemDirectoryHandle,
  requestedPath: string,
  runCommands: RunCommandMap,
): Promise<RunToolResolution> {
  const resolved = await resolveWorkspaceFiles(rootHandle, [requestedPath]);
  const node = resolved.get(requestedPath);
  if (!node) {
    return { ok: false, path: requestedPath, message: `「${requestedPath}」はワークスペース内に見つかりませんでした。` };
  }
  const ext = extensionOf(node.name);
  const template = ext ? runCommands[ext] : undefined;
  if (!template) {
    return {
      ok: false,
      path: requestedPath,
      message: `「${requestedPath}」の拡張子に対応する実行コマンドが設定されていません(設定 > 拡張子ごとの実行コマンド から追加できます)。`,
    };
  }
  const command = buildRunCommand(template, resolveRelativeFilePath(node.pathSegments));
  return { ok: true, path: requestedPath, command };
}

/** Resolves a Copilot-requested `TOOL_RUN_NAMED: <name>` against the user's
 * own pre-configured namedCommandStore mapping — for project-level commands
 * (tests, git, lint, build) that aren't tied to any single file, so
 * resolveRunToolRequest's extension lookup doesn't apply. Same contract as
 * resolveRunToolRequest: Copilot only ever names a key, never a shell
 * command; the actual command always comes from the user's own trusted
 * config, and callers must still confirm before running it. Reuses
 * RunToolResolution's `path` field as a generic "identifier" slot (a name
 * here, a workspace path there) — ToolRunConfirmation displays it either
 * way, so a separate type isn't worth the duplication. */
export function resolveNamedToolRequest(name: string, namedCommands: NamedCommandMap): RunToolResolution {
  const command = namedCommands[name];
  if (!command) {
    return {
      ok: false,
      path: name,
      message: `「${name}」という名前付きコマンドは設定されていません(設定 > 名前付きコマンド から追加できます)。`,
    };
  }
  return { ok: true, path: name, command };
}
