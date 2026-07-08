import type { FileTreeNode } from '../../../shared/types';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import '../MenuBar.css';

export interface ContextMenuState {
  x: number;
  y: number;
  /** null means the tree's empty area / root was right-clicked. */
  node: FileTreeNode | null;
}

interface TreeContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  /** contextNode is the right-clicked node (or null for the root/empty
   * area) — the caller resolves it to an actual create target, since a
   * file's "new file/folder" targets its containing directory. */
  onNewFile: (contextNode: FileTreeNode | null) => void;
  onNewFolder: (contextNode: FileTreeNode | null) => void;
  onRename: (node: FileTreeNode) => void;
  onDelete: (node: FileTreeNode) => void;
}

export function TreeContextMenu({
  state,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: TreeContextMenuProps) {
  useDismissOnOutsideClick(onClose, true, ['click', 'contextmenu']);

  const { node } = state;

  const items: { label: string; onClick: () => void }[] = [
    { label: '新しいファイル...', onClick: () => onNewFile(node) },
    { label: '新しいフォルダ...', onClick: () => onNewFolder(node) },
  ];
  if (node) {
    items.push(
      { label: '名前を変更...', onClick: () => onRename(node) },
      { label: '削除', onClick: () => onDelete(node) },
    );
  }

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
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
