import { listWorkspaceFiles } from './workspaceFileList';
import { readFileText } from '../fs/fsaWorkspace';

const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 500;
const MAX_LIST_RESULTS = 300;

/**
 * Read-only local stand-ins for the search tools Copilot can't call itself
 * (it only ever sees pasted-in text, never runs code) — invoked via the
 * TOOL_GREP / TOOL_LIST_FILES text convention taught in the prompt
 * templates, executed here entirely locally, then folded into a follow-up
 * prompt. Bounded (file count, match count) since this walks real file
 * contents rather than an index.
 */
export async function runGrepSearch(rootHandle: FileSystemDirectoryHandle, pattern: string): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return `検索パターンが正規表現として不正です: ${pattern}`;
  }

  const files = await listWorkspaceFiles(rootHandle);
  const matches: string[] = [];
  let filesScanned = 0;

  for (const file of files) {
    if (filesScanned >= MAX_GREP_FILES || matches.length >= MAX_GREP_MATCHES) break;
    filesScanned++;
    let text: string;
    try {
      text = await readFileText(file.handle as FileSystemFileHandle);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${file.id}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (matches.length === 0) return `「${pattern}」に一致する行は見つかりませんでした。`;
  const truncated = matches.length >= MAX_GREP_MATCHES ? `\n...(上限${MAX_GREP_MATCHES}件で打ち切り)` : '';
  return matches.join('\n') + truncated;
}

export async function runListFiles(rootHandle: FileSystemDirectoryHandle, query: string): Promise<string> {
  const files = await listWorkspaceFiles(rootHandle);
  const q = query.trim().toLowerCase();
  const matched = q ? files.filter((f) => f.id.toLowerCase().includes(q)) : files;

  if (matched.length === 0) return `「${query}」に一致するファイルは見つかりませんでした。`;
  const truncated = matched.length > MAX_LIST_RESULTS ? `\n...(上限${MAX_LIST_RESULTS}件で打ち切り)` : '';
  return matched
    .slice(0, MAX_LIST_RESULTS)
    .map((f) => f.id)
    .join('\n') + truncated;
}
