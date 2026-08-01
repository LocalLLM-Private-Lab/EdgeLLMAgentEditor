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
  onCopy: (node: FileTreeNode) => void;
  onCopyRelativePath: (node: FileTreeNode) => void;
  /** contextNode is where to paste — null means the root/empty area. */
  onPaste: (contextNode: FileTreeNode | null) => void;
  canPaste: boolean;
  onCompare?: () => void;
  canCompare?: boolean;
}

export function TreeContextMenu({
  state,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopy,
  onCopyRelativePath,
  onPaste,
  canPaste,
  onCompare,
  canCompare = false,
}: TreeContextMenuProps) {
  useDismissOnOutsideClick(onClose, true, ['click', 'contextmenu']);

  const { node } = state;

  const items: { label: string; onClick: () => void }[] = [
    { label: '新しいファイル...', onClick: () => onNewFile(node) },
    { label: '新しいフォルダ...', onClick: () => onNewFolder(node) },
  ];
  if (node) {
    items.push({ label: 'コピー', onClick: () => onCopy(node) });
  }
  if (canPaste) {
    items.push({ label: '貼り付け', onClick: () => onPaste(node) });
  }
  if (canCompare && onCompare) {
    items.push({ label: '選択した2ファイルを比較', onClick: onCompare });
  }
  if (node) {
    items.push(
      { label: '相対パスのコピー', onClick: () => onCopyRelativePath(node) },
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
