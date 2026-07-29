import { useOpenAnywayPromptStore } from '../state/openAnywayPromptStore';
import './OpenAnywayModal.css';

/** Mounted once (App.tsx), always present — renders nothing until
 * editorTabsStore.ts's openFile() asks (via openAnywayPromptStore) for
 * confirmation before decoding a file that looks binary (a NUL byte in its
 * leading bytes — see fs/fileKind.ts's looksBinary) as text. Image files
 * never reach this: they get their own viewer tab (ImageViewerPane.tsx)
 * instead of either path. */
export function OpenAnywayModal() {
  const pending = useOpenAnywayPromptStore((s) => s.pending);
  const respond = useOpenAnywayPromptStore((s) => s.respond);

  if (!pending) return null;

  return (
    <div className="open-anyway-overlay" onClick={() => respond(false)}>
      <div className="open-anyway-modal" onClick={(e) => e.stopPropagation()}>
        <h2>テキストとして開きますか?</h2>
        <p>
          「{pending.fileName}」はバイナリファイルの可能性があり、テキストとして正しく表示・編集できないかもしれません。
        </p>
        <div className="open-anyway-actions">
          <button autoFocus onClick={() => respond(false)}>
            キャンセル
          </button>
          <button className="danger" onClick={() => respond(true)}>
            Open Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
