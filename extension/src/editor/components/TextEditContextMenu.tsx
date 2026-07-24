import { useEffect, useState } from 'react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import './MenuBar.css';

export interface TextEditMenuState {
  x: number;
  y: number;
  target: HTMLInputElement | HTMLTextAreaElement;
}

function getSelectedText(target: HTMLInputElement | HTMLTextAreaElement): string {
  const { selectionStart, selectionEnd, value } = target;
  if (selectionStart == null || selectionEnd == null || selectionStart === selectionEnd) return '';
  return value.slice(selectionStart, selectionEnd);
}

function replaceSelection(target: HTMLInputElement | HTMLTextAreaElement, insert: string) {
  const { selectionStart, selectionEnd, value } = target;
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? value.length;
  // React tracks the input's value via a wrapped native setter, so a plain
  // `target.value = ...` assignment gets silently ignored on the next
  // render — going through the real prototype setter first (then firing
  // a native 'input' event) is what makes React's onChange see the change,
  // same trick React DevTools/testing-library use for this exact reason.
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  nativeSetter?.call(target, value.slice(0, start) + insert + value.slice(end));
  target.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = start + insert.length;
  target.focus();
  target.setSelectionRange(caret, caret);
}

/** Generic 切り取り/コピー/貼り付け menu for plain text inputs/textareas
 * that don't have a more specific context menu of their own (file tree
 * rows, editor tabs, the terminal, and Monaco all supply richer menus and
 * are excluded before this ever mounts — see App.tsx). Every item grays
 * itself out rather than disappearing when it wouldn't do anything, so
 * the menu's shape doesn't jump around depending on selection/clipboard
 * state. */
export function TextEditContextMenu({ state, onClose }: { state: TextEditMenuState; onClose: () => void }) {
  useDismissOnOutsideClick(onClose, true, ['click', 'contextmenu']);
  const { target } = state;

  const selected = getSelectedText(target);
  const hasSelection = selected.length > 0;
  const canCut = hasSelection && !target.readOnly && !target.disabled;
  const canCopy = hasSelection;
  // Optimistic default (readOnly/disabled fields can never accept a
  // paste), refined once the async clipboard read below resolves.
  const [canPaste, setCanPaste] = useState(!target.readOnly && !target.disabled);

  useEffect(() => {
    if (target.readOnly || target.disabled) return;
    let cancelled = false;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!cancelled) setCanPaste(text.length > 0);
      })
      .catch(() => {
        // Permission denied, or nothing text-like on the clipboard right
        // now — leave the optimistic default rather than guessing wrong.
      });
    return () => {
      cancelled = true;
    };
    // target identity is stable for this menu's lifetime (a fresh menu
    // instance is mounted per right-click via React's key-less remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCut() {
    if (!canCut) return;
    await navigator.clipboard.writeText(selected);
    replaceSelection(target, '');
    onClose();
  }

  async function handleCopy() {
    if (!canCopy) return;
    await navigator.clipboard.writeText(selected);
    onClose();
  }

  async function handlePaste() {
    if (!canPaste) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      replaceSelection(target, text);
    } catch {
      // Clipboard read blocked after all — nothing to do.
    }
    onClose();
  }

  const items: { label: string; onClick: () => void; disabled: boolean }[] = [
    { label: '切り取り', onClick: () => void handleCut(), disabled: !canCut },
    { label: 'コピー', onClick: () => void handleCopy(), disabled: !canCopy },
    { label: '貼り付け', onClick: () => void handlePaste(), disabled: !canPaste },
  ];

  return (
    <div
      className="menu-dropdown"
      style={{ position: 'fixed', top: state.y, left: state.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className="menu-dropdown-item"
          disabled={item.disabled}
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
