import { memo, useCallback, useState } from 'react';
import { create } from 'zustand';
import type { FileTreeNode } from '../../../shared/types';
import { useWorkspaceStore, directoryTargetFor, type DirectoryTarget } from '../../state/workspaceStore';
import { useEditorTabsStore } from '../../state/editorTabsStore';
import { TreeContextMenu, type ContextMenuState } from './TreeContextMenu';
import { InlineNameInput } from './InlineNameInput';
import './FileTree.css';

interface CreatingState {
  target: DirectoryTarget | null;
  kind: 'file' | 'directory';
}

/** Transient UI-only state (which row is being renamed / where a new-item
 * input is showing) — colocated here as its own tiny store so deeply
 * nested TreeNodes can read it without prop-drilling through every level. */
interface FileTreeUiState {
  creatingIn: CreatingState | null;
  renamingNodeId: string | null;
  setCreatingIn: (v: CreatingState | null) => void;
  setRenamingNodeId: (id: string | null) => void;
}

const useFileTreeUi = create<FileTreeUiState>((set) => ({
  creatingIn: null,
  renamingNodeId: null,
  setCreatingIn: (creatingIn) => set({ creatingIn }),
  setRenamingNodeId: (renamingNodeId) => set({ renamingNodeId }),
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
  const creatingHere = useFileTreeUi(
    (s) => s.creatingIn && node.kind === 'directory' && creatingParentId(s.creatingIn.target) === node.id,
  );
  const creatingKind = useFileTreeUi((s) => s.creatingIn?.kind);

  const handleClick = () => {
    if (node.kind === 'directory') {
      void toggleExpand(node);
    } else {
      void openFile(node);
    }
  };

  return (
    <div>
      <div
        className="file-tree-row"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={isRenaming ? undefined : handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="file-tree-chevron">
          {node.kind === 'directory' ? (isExpanded ? '▼' : '▶') : ''}
        </span>
        <span className="file-tree-icon">
          {node.kind === 'directory' ? (isExpanded ? '📂' : '📁') : '📄'}
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
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);

  const rootCreating = useFileTreeUi((s) => s.creatingIn && creatingParentId(s.creatingIn.target) === '');
  const rootCreatingKind = useFileTreeUi((s) => s.creatingIn?.kind);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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

  async function handleDelete(node: FileTreeNode) {
    const kindLabel = node.kind === 'directory' ? 'フォルダ' : 'ファイル';
    if (!window.confirm(`${kindLabel}「${node.name}」を削除しますか？この操作は取り消せません。`)) {
      return;
    }
    try {
      await deleteEntry(node);
    } catch (err) {
      window.alert(`削除できませんでした: ${(err as Error).message}`);
    }
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
          onDelete={(node) => void handleDelete(node)}
        />
      )}
    </div>
  );
}
