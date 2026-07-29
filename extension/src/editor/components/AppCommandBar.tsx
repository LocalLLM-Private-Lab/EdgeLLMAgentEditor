import { useRef, useState, type KeyboardEvent } from 'react';
import { fuzzyScore, type Command } from '../commands/appCommands';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import './AppCommandBar.css';

/** Always-visible command input centered in the header (App.tsx) — the
 * same commands QuickOpenModal's Ctrl+P ">" mode reaches, just via a
 * persistent bar instead of a popup (mirrors VS Code's own always-present
 * top-center search/command bar). Both are handed the same `commands`
 * list (defined once in App.tsx) so they can never drift apart. */
export function AppCommandBar({ commands }: { commands: Command[] }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = query.trim()
    ? commands
        .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
        .filter((x): x is { c: Command; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
    : commands;

  useDismissOnOutsideClick(() => setOpen(false), open);

  function run(cmd: Command) {
    cmd.run();
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[selectedIndex];
      if (cmd) run(cmd);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div className="app-command-bar" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="app-command-bar-input"
        placeholder="コマンドを入力... (例: 実パス)"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && results.length > 0 && (
        <div className="app-command-bar-list">
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`app-command-bar-item ${i === selectedIndex ? 'active' : ''}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => run(cmd)}
            >
              {cmd.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
