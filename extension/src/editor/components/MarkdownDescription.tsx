import type { ReactNode } from 'react';
import { executeExtensionCommand } from '../extensions/extensionHostClient';
import '@vscode/codicons/dist/codicon.css';
import './MarkdownDescription.css';

// A deliberately small subset of what a real VS Code `markdownDescription`
// commonly contains — not a CommonMark implementation. Covers exactly what
// shows up in practice: codicon references ($(name)), links (including
// `command:...` links that trigger a registered command), bold, and inline
// code.
type Token =
  | { kind: 'text'; value: string }
  | { kind: 'icon'; name: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; label: string; url: string };

const TOKEN_RE = /\[([^\]]*)\]\(([^)]*)\)|\$\(([a-z0-9-]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/gi;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) tokens.push({ kind: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'link', label: m[1], url: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: 'icon', name: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: 'bold', text: m[4] });
    else if (m[5] !== undefined) tokens.push({ kind: 'code', text: m[5] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}

/** `command:id?args` — `args` is a JSON value (VS Code's own convention:
 * `encodeURIComponent(JSON.stringify(argsOrSingleValue))`). An array is
 * spread as multiple arguments; anything else becomes the single first
 * argument. Malformed query strings just drop the arguments rather than
 * failing the whole link. */
function parseCommandUrl(url: string): { command: string; args: unknown[] } | null {
  if (!url.startsWith('command:')) return null;
  const rest = url.slice('command:'.length);
  const qIndex = rest.indexOf('?');
  const command = qIndex === -1 ? rest : rest.slice(0, qIndex);
  if (!command) return null;
  if (qIndex === -1) return { command, args: [] };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(rest.slice(qIndex + 1)));
    return { command, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { command, args: [] };
  }
}

function renderTokens(tokens: Token[], extensionId: string, active: boolean): ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.kind) {
      case 'text':
        return <span key={i}>{token.value}</span>;
      case 'icon':
        return <span key={i} className={`codicon codicon-${token.name}`} aria-hidden="true" />;
      case 'bold':
        return <strong key={i}>{renderTokens(tokenize(token.text), extensionId, active)}</strong>;
      case 'code':
        return <code key={i}>{token.text}</code>;
      case 'link': {
        const inner = renderTokens(tokenize(token.label), extensionId, active);
        const parsed = parseCommandUrl(token.url);
        if (parsed) {
          return (
            <button
              key={i}
              type="button"
              className="ext-settings-command-link"
              disabled={!active}
              title={active ? undefined : '有効化すると使用できます'}
              onClick={() => executeExtensionCommand(extensionId, parsed.command, parsed.args)}
            >
              {inner}
            </button>
          );
        }
        return (
          <a key={i} href={token.url} target="_blank" rel="noreferrer" className="ext-settings-command-link">
            {inner}
          </a>
        );
      }
    }
  });
}

interface MarkdownDescriptionProps {
  text: string;
  extensionId: string;
  /** Command links only make sense (and only work — the command lives in
   * a running Node process) while the extension is active; shown
   * disabled otherwise rather than hidden, so the option is still
   * discoverable. */
  active: boolean;
}

export function MarkdownDescription({ text, extensionId, active }: MarkdownDescriptionProps) {
  return <p className="settings-row-description">{renderTokens(tokenize(text), extensionId, active)}</p>;
}
