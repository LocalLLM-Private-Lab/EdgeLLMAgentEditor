import { useEffect, useMemo, useRef, useState } from 'react';
import { useExtensionQuickPickStore } from '../state/extensionQuickPickStore';
import { resolveExtensionQuickPick } from '../extensions/extensionHostClient';
import './ExtensionQuickPick.css';

/** `vscode.window.showQuickPick(...)` rendered as a real, interactive
 * overlay — modeled on QuickOpenModal.tsx's filter+keyboard-nav pattern.
 * Always mounted at the app root (App.tsx) so it can appear regardless of
 * which panel/view triggered the underlying command (a settings link, a
 * webview action, ...) — see extensionHostClient.ts's
 * initExtensionHostBridge for how a request arrives here. */
export function ExtensionQuickPick() {
  const request = useExtensionQuickPickStore((s) => s.request);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQuery('');
    setActiveIndex(0);
    setChecked(new Set());
    inputRef.current?.focus();
  }, [request?.requestId]);

  const filtered = useMemo(() => {
    if (!request) return [];
    const q = query.trim().toLowerCase();
    if (!q) return request.items.map((item, index) => ({ item, index }));
    return request.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => `${item.label} ${item.description ?? ''} ${item.detail ?? ''}`.toLowerCase().includes(q));
  }, [request, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!request) return null;
  // Narrowed once here (rather than `request!` everywhere below) — TS
  // can't otherwise prove `request` stays non-null inside closures
  // defined after this guard.
  const req = request;

  function cancel() {
    resolveExtensionQuickPick(req.extensionId, req.requestId, null);
  }

  function confirmSingle(index: number) {
    resolveExtensionQuickPick(req.extensionId, req.requestId, index);
  }

  function toggleChecked(index: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function confirmMany() {
    resolveExtensionQuickPick(req.extensionId, req.requestId, [...checked]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (!target) return;
      if (req.canPickMany) toggleChecked(target.index);
      else confirmSingle(target.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <div className="ext-quick-pick-overlay" onClick={cancel}>
      <div className="ext-quick-pick-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ext-quick-pick-input"
          placeholder={req.placeHolder ?? '選択してください'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="ext-quick-pick-list">
          {filtered.length === 0 ? (
            <div className="ext-quick-pick-empty">該当する項目がありません</div>
          ) : (
            filtered.map(({ item, index }, i) => (
              <div
                key={index}
                className={`ext-quick-pick-item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => (req.canPickMany ? toggleChecked(index) : confirmSingle(index))}
              >
                {req.canPickMany && (
                  <input type="checkbox" checked={checked.has(index)} readOnly className="ext-quick-pick-checkbox" />
                )}
                <div className="ext-quick-pick-item-text">
                  <div className="ext-quick-pick-item-label">{item.label}</div>
                  {item.description && <div className="ext-quick-pick-item-description">{item.description}</div>}
                  {item.detail && <div className="ext-quick-pick-item-detail">{item.detail}</div>}
                </div>
              </div>
            ))
          )}
        </div>
        {req.canPickMany && (
          <div className="ext-quick-pick-actions">
            <button onClick={cancel}>キャンセル</button>
            <button className="primary" onClick={confirmMany}>
              OK({checked.size})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
