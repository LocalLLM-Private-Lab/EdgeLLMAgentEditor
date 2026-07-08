import { useEffect, useRef, useState } from 'react';

interface InlineNameInputProps {
  initialValue: string;
  /** Selects only the name (not the extension) on focus, VSCode-style —
   * irrelevant for new-folder/new-file-with-no-dot cases. */
  selectBaseNameOnly?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InlineNameInput({
  initialValue,
  selectBaseNameOnly,
  onConfirm,
  onCancel,
}: InlineNameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectBaseNameOnly) {
      const dot = initialValue.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    } else {
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  }

  function cancel() {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  }

  return (
    <input
      ref={inputRef}
      className="file-tree-inline-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}
