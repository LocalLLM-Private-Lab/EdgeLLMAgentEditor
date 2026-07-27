import { useEditorTabsStore } from '../state/editorTabsStore';
import './EditorToolbar.css';

// Global (not per-group) navigation/save controls — back/forward walks a
// single window-wide history spanning every group, same as VS Code; save
// always acts on whichever group currently has focus (editorTabsStore's
// activeFileId mirrors that). Each group's own tab strip lives in
// EditorGroupPane instead of here.
export function EditorToolbar() {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const navIndex = useEditorTabsStore((s) => s.navIndex);
  const navHistoryLength = useEditorTabsStore((s) => s.navHistory.length);
  const goBack = useEditorTabsStore((s) => s.goBack);
  const goForward = useEditorTabsStore((s) => s.goForward);
  const saveFile = useEditorTabsStore((s) => s.saveFile);
  const saveAllFiles = useEditorTabsStore((s) => s.saveAllFiles);

  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const hasDirty = openFiles.some((f) => f.isDirty);

  return (
    <div className="editor-toolbar">
      <button
        className="editor-toolbar-button"
        disabled={navIndex <= 0}
        onClick={() => goBack()}
        title="戻る"
        aria-label="戻る"
      >
        ←
      </button>
      <button
        className="editor-toolbar-button"
        disabled={navIndex >= navHistoryLength - 1}
        onClick={() => goForward()}
        title="進む"
        aria-label="進む"
      >
        →
      </button>
      <button
        className="editor-toolbar-button"
        disabled={!activeTab || !activeTab.isDirty}
        onClick={() => activeFileId && void saveFile(activeFileId)}
        title="保存"
        aria-label="保存"
      >
        💾
      </button>
      <button
        className="editor-toolbar-button"
        disabled={!hasDirty}
        onClick={() => void saveAllFiles()}
        title="すべて保存"
        aria-label="すべて保存"
      >
        💾*
      </button>
    </div>
  );
}
