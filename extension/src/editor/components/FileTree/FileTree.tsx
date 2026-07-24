import { memo, useCallback, useState } from 'react';
import { create } from 'zustand';
import type { FileTreeNode } from '../../../shared/types';
import { useWorkspaceStore, directoryTargetFor, type DirectoryTarget } from '../../state/workspaceStore';
import { useEditorTabsStore } from '../../state/editorTabsStore';
import { TreeContextMenu, type ContextMenuState } from './TreeContextMenu';
import { InlineNameInput } from './InlineNameInput';
import { FileIcon } from '../FileIcon';
import './FileTree.css';

interface CreatingState {
  target: DirectoryTarget | null;
  kind: 'file' | 'directory';
}

/** Transient UI-only state (which row is being renamed / where a new-item
 * input is showing / which row is selected+what's on the copy clipboard) —
 * colocated here as its own tiny store so deeply nested TreeNodes can read
 * it without prop-drilling through every level. */
interface FileTreeUiState {
  creatingIn: CreatingState | null;
  renamingNodeId: string | null;
  selectedNodeIds: Set<string>;
  clipboardNode: FileTreeNode | null;
  setCreatingIn: (v: CreatingState | null) => void;
  setRenamingNodeId: (id: string | null) => void;
  setClipboardNode: (node: FileTreeNode | null) => void;
  /** Plain click — replaces the whole selection with just this one node. */
  selectOnly: (id: string) => void;
  /** Ctrl/Cmd+click — adds or removes this node from the selection without
   * touching the rest, VS Code's Explorer multi-select convention. */
  toggleSelected: (id: string) => void;
}

const useFileTreeUi = create<FileTreeUiState>((set, get) => ({
  creatingIn: null,
  renamingNodeId: null,
  selectedNodeIds: new Set(),
  clipboardNode: null,
  setCreatingIn: (creatingIn) => set({ creatingIn }),
  setRenamingNodeId: (renamingNodeId) => set({ renamingNodeId }),
  setClipboardNode: (clipboardNode) => set({ clipboardNode }),
  selectOnly: (id) => set({ selectedNodeIds: new Set([id]) }),
  toggleSelected: (id) => {
    const next = new Set(get().selectedNodeIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedNodeIds: next });
  },
}));

function creatingParentId(target: DirectoryTarget | null): string {
  return target ? target.pathSegments.join('/') : '';
}

function findNodeByPath(nodes: FileTreeNode[], pathSegments: string[]): FileTreeNode | null {
  const targetId = pathSegments.join('/');
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, pathSegments);
      if (found) return found;
    }
  }
  return null;
}

async function handleCreateConfirm(name: string) {
  const { creatingIn, setCreatingIn } = useFileTreeUi.getState();
  if (!creatingIn) return;
  setCreatingIn(null);
  const { createFile, createFolder } = useWorkspaceStore.getState();
  try {
    if (creatingIn.kind === 'file') {
      await createFile(creatingIn.target, name);
    } else {
      await createFolder(creatingIn.target, name);
    }
    const parentPath = creatingIn.target ? creatingIn.target.pathSegments : [];
    const newNode = findNodeByPath(useWorkspaceStore.getState().tree, [...parentPath, name]);
    if (newNode && creatingIn.kind === 'file') {
      void useEditorTabsStore.getState().openFile(newNode);
    }
  } catch (err) {
    window.alert(`作成できませんでした: ${(err as Error).message}`);
  }
}

async function handleRenameConfirm(node: FileTreeNode, newName: string) {
  useFileTreeUi.getState().setRenamingNodeId(null);
  if (newName === node.name) return;
  try {
    await useWorkspaceStore.getState().renameEntry(node, newName);
  } catch (err) {
    window.alert(`名前を変更できませんでした: ${(err as Error).message}`);
  }
}

function handleCopyRelativePath(node: FileTreeNode) {
  void navigator.clipboard.writeText(node.pathSegments.join('/'));
}

async function handleDeleteNodes(nodes: FileTreeNode[]) {
  if (nodes.length === 0) return;
  const label =
    nodes.length === 1
      ? `${nodes[0].kind === 'directory' ? 'フォルダ' : 'ファイル'}「${nodes[0].name}」`
      : `選択中の${nodes.length}件`;
  if (!window.confirm(`${label}を削除しますか？この操作は取り消せません。`)) {
    return;
  }
  try {
    for (const node of nodes) {
      await useWorkspaceStore.getState().deleteEntry(node);
    }
  } catch (err) {
    window.alert(`削除できませんでした: ${(err as Error).message}`);
  }
}

function handleDeleteNode(node: FileTreeNode) {
  return handleDeleteNodes([node]);
}

/** Paste target: pasting "on" a directory (or the root/empty area, null)
 * puts the copy inside it; pasting on a file puts it alongside that file,
 * in its parent — same convention directoryTargetFor() already uses for
 * new-file/new-folder. */
async function handlePasteInto(targetNode: FileTreeNode | null) {
  const { clipboardNode } = useFileTreeUi.getState();
  if (!clipboardNode) return;
  try {
    await useWorkspaceStore.getState().copyEntry(clipboardNode, directoryTargetFor(targetNode));
  } catch (err) {
    window.alert(`貼り付けできませんでした: ${(err as Error).message}`);
  }
}

function handleTreeNodeKeyDown(e: React.KeyboardEvent, node: FileTreeNode, isRenaming: boolean) {
  if (isRenaming) return;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (ctrlOrCmd && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    useFileTreeUi.getState().setClipboardNode(node);
  } else if (ctrlOrCmd && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    void handlePasteInto(node);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    const { selectedNodeIds } = useFileTreeUi.getState();
    if (selectedNodeIds.size > 1 && selectedNodeIds.has(node.id)) {
      const tree = useWorkspaceStore.getState().tree;
      const nodes = [...selectedNodeIds]
        .map((id) => findNodeByPath(tree, id.split('/')))
        .filter((n): n is FileTreeNode => n !== null);
      void handleDeleteNodes(nodes);
    } else {
      void handleDeleteNode(node);
    }
  } else if (e.key === 'F2') {
    e.preventDefault();
    useFileTreeUi.getState().setRenamingNodeId(node.id);
  }
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  onContextMenu,
}: {
  node: FileTreeNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
}) {
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const openFile = useEditorTabsStore((s) => s.openFile);
  const isExpanded = node.childrenLoaded === true;

  const isRenaming = useFileTreeUi((s) => s.renamingNodeId === node.id);
  const isSelected = useFileTreeUi((s) => s.selectedNodeIds.has(node.id));
  const creatingHere = useFileTreeUi(
    (s) => s.creatingIn && node.kind === 'directory' && creatingParentId(s.creatingIn.target) === node.id,
  );
  const creatingKind = useFileTreeUi((s) => s.creatingIn?.kind);

  const handleClick = (e: React.MouseEvent) => {
    // Ctrl/Cmd+click only toggles this row in/out of the selection — VS
    // Code's Explorer doesn't also open the file or expand the folder on
    // that click, since it's a pure selection gesture.
    if (e.ctrlKey || e.metaKey) {
      useFileTreeUi.getState().toggleSelected(node.id);
      return;
    }
    useFileTreeUi.getState().selectOnly(node.id);
    if (node.kind === 'directory') {
      void toggleExpand(node);
    } else {
      // Single click opens as a preview (VS Code's Explorer behavior) —
      // reuses the same tab slot on each subsequent single-click browse
      // instead of piling up a new permanent tab per file.
      void openFile(node, { preview: true });
    }
  };

  const handleDoubleClick = () => {
    // Double click "really" opens it — pins the tab (or the existing
    // preview tab for this same file) so it stops being replaceable.
    if (node.kind === 'file') void openFile(node, { preview: false });
  };

  return (
    <div>
      <div
        className={`file-tree-row ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        tabIndex={0}
        onClick={isRenaming ? undefined : handleClick}
        onDoubleClick={isRenaming ? undefined : handleDoubleClick}
        onKeyDown={(e) => handleTreeNodeKeyDown(e, node, isRenaming)}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="file-tree-chevron">
          {node.kind === 'directory' ? (isExpanded ? '▼' : '▶') : ''}
        </span>
        <span className="file-tree-icon">
          {node.kind === 'directory' ? (isExpanded ? '📂' : '📁') : <FileIcon name={node.name} />}
        </span>
        {isRenaming ? (
          <InlineNameInput
            initialValue={node.name}
            selectBaseNameOnly={node.kind === 'file'}
            onConfirm={(name) => void handleRenameConfirm(node, name)}
            onCancel={() => useFileTreeUi.getState().setRenamingNodeId(null)}
          />
        ) : (
          <span className="file-tree-name">{node.name}</span>
        )}
      </div>
      {node.kind === 'directory' && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} onContextMenu={onContextMenu} />
          ))}
          {creatingHere && (
            <div className="file-tree-row" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
              <span className="file-tree-chevron" />
              <span className="file-tree-icon">{creatingKind === 'directory' ? '📁' : '📄'}</span>
              <InlineNameInput
                initialValue=""
                onConfirm={(name) => void handleCreateConfirm(name)}
                onCancel={() => useFileTreeUi.getState().setCreatingIn(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function FileTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);

  const rootCreating = useFileTreeUi((s) => s.creatingIn && creatingParentId(s.creatingIn.target) === '');
  const rootCreatingKind = useFileTreeUi((s) => s.creatingIn?.kind);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const hasClipboard = useFileTreeUi((s) => s.clipboardNode !== null);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileTreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  async function startCreate(contextNode: FileTreeNode | null, kind: 'file' | 'directory') {
    if (contextNode && contextNode.kind === 'directory' && !contextNode.childrenLoaded) {
      await toggleExpand(contextNode);
    }
    useFileTreeUi.getState().setCreatingIn({ target: directoryTargetFor(contextNode), kind });
  }

  return (
    <div className="file-tree" onContextMenu={(e) => handleContextMenu(e, null)}>
      {tree.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} onContextMenu={handleContextMenu} />
      ))}
      {rootCreating && (
        <div className="file-tree-row" style={{ paddingLeft: '8px' }}>
          <span className="file-tree-chevron" />
          <span className="file-tree-icon">{rootCreatingKind === 'directory' ? '📁' : '📄'}</span>
          <InlineNameInput
            initialValue=""
            onConfirm={(name) => void handleCreateConfirm(name)}
            onCancel={() => useFileTreeUi.getState().setCreatingIn(null)}
          />
        </div>
      )}
      {contextMenu && (
        <TreeContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onNewFile={(node) => void startCreate(node, 'file')}
          onNewFolder={(node) => void startCreate(node, 'directory')}
          onRename={(node) => useFileTreeUi.getState().setRenamingNodeId(node.id)}
          onDelete={(node) => void handleDeleteNode(node)}
          onCopy={(node) => useFileTreeUi.getState().setClipboardNode(node)}
          onCopyRelativePath={(node) => handleCopyRelativePath(node)}
          onPaste={(node) => void handlePasteInto(node)}
          canPaste={hasClipboard}
        />
      )}
    </div>
  );
}
