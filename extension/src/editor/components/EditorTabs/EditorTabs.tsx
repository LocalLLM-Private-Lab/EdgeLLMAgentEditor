import { useEditorTabsStore } from '../../state/editorTabsStore';
import './EditorTabs.css';

export function EditorTabs() {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.activeFileId);
  const setActiveFile = useEditorTabsStore((s) => s.setActiveFile);
  const closeFile = useEditorTabsStore((s) => s.closeFile);

  const navIndex = useEditorTabsStore((s) => s.navIndex);
  const navHistoryLength = useEditorTabsStore((s) => s.navHistory.length);
  const goBack = useEditorTabsStore((s) => s.goBack);
  const goForward = useEditorTabsStore((s) => s.goForward);
  const saveFile = useEditorTabsStore((s) => s.saveFile);
  const saveAllFiles = useEditorTabsStore((s) => s.saveAllFiles);

  const activeTab = openFiles.find((f) => f.id === activeFileId);
  const hasDirty = openFiles.some((f) => f.isDirty);

  return (
    <div className="editor-tabs-row">
      <div className="editor-tabs-actions">
        <button
          className="editor-tabs-action-button"
          disabled={navIndex <= 0}
          onClick={() => goBack()}
          title="戻る"
          aria-label="戻る"
        >
          ←
        </button>
        <button
          className="editor-tabs-action-button"
          disabled={navIndex >= navHistoryLength - 1}
          onClick={() => goForward()}
          title="進む"
          aria-label="進む"
        >
          →
        </button>
        <button
          className="editor-tabs-action-button"
          disabled={!activeTab || !activeTab.isDirty}
          onClick={() => activeFileId && void saveFile(activeFileId)}
          title="保存"
          aria-label="保存"
        >
          💾
        </button>
        <button
          className="editor-tabs-action-button"
          disabled={!hasDirty}
          onClick={() => void saveAllFiles()}
          title="すべて保存"
          aria-label="すべて保存"
        >
          💾*
        </button>
      </div>
      <div className="editor-tabs">
        {openFiles.map((tab) => (
          <div
            key={tab.id}
            className={`editor-tab ${tab.id === activeFileId ? 'active' : ''}`}
            onClick={() => setActiveFile(tab.id)}
          >
            <span className="editor-tab-name">
              {tab.isDirty ? '● ' : ''}
              {tab.name}
            </span>
            <button
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(tab.id);
              }}
              aria-label={`${tab.name} を閉じる`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
