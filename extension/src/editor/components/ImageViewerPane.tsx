import { useEditorTabsStore } from '../state/editorTabsStore';
import './ImageViewerPane.css';

/** Shows the active tab's image when it's an image-kind tab (see
 * editorTabsStore.ts's openFile — png/jpg/gif/webp/bmp/ico/svg/avif get a
 * data-URL tab instead of being decoded as text). Rendered by
 * EditorGroupPane.tsx as a third content slot alongside MonacoEditorPane/
 * ExtensionDetailView, same display-toggle-not-unmount pattern as those. */
export function ImageViewerPane({ groupId }: { groupId: string }) {
  const openFiles = useEditorTabsStore((s) => s.openFiles);
  const activeFileId = useEditorTabsStore((s) => s.groups[groupId]?.activeFileId ?? null);
  const activeTab = openFiles.find((f) => f.id === activeFileId);

  if (!activeTab || activeTab.kind !== 'image' || !activeTab.imageDataUrl) return null;

  return (
    <div className="image-viewer-pane">
      <img className="image-viewer-pane-img" src={activeTab.imageDataUrl} alt={activeTab.name} />
      <div className="image-viewer-pane-name">{activeTab.name}</div>
    </div>
  );
}
