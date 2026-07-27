import { Fragment, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditorTabsStore, type EditorLayoutNode } from '../state/editorTabsStore';
import { EditorGroupPane } from './EditorGroupPane';
import './EditorLayout.css';

function nodeKey(node: EditorLayoutNode): string {
  return node.type === 'leaf' ? node.groupId : node.id;
}

function SplitNode({ node }: { node: Extract<EditorLayoutNode, { type: 'split' }> }) {
  const resizeLayoutPane = useEditorTabsStore((s) => s.resizeLayoutPane);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  // Which divider (index into node.children, referring to the boundary
  // between children[index] and children[index+1]) is being dragged.
  const dragState = useRef<{ index: number; pos: number; startSizeAtIndex: number } | null>(null);

  const onDividerPointerDown = useCallback(
    (index: number) => (e: ReactPointerEvent) => {
      dragState.current = {
        index,
        pos: node.direction === 'row' ? e.clientX : e.clientY,
        startSizeAtIndex: node.sizes[index],
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [node.direction, node.sizes],
  );

  const onDividerPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragState.current;
      if (!drag || !containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const total = node.direction === 'row' ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = node.direction === 'row' ? e.clientX : e.clientY;
      const delta = (pos - drag.pos) / total;
      resizeLayoutPane(node.id, drag.index, drag.startSizeAtIndex + delta);
    },
    [containerEl, node.direction, node.id, resizeLayoutPane],
  );

  const onDividerPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  return (
    <div ref={setContainerEl} className={`editor-layout-split editor-layout-split-${node.direction}`}>
      {node.children.map((child, i) => (
        <Fragment key={nodeKey(child)}>
          <div
            className="editor-layout-pane"
            style={node.direction === 'row' ? { width: `${node.sizes[i] * 100}%` } : { height: `${node.sizes[i] * 100}%` }}
          >
            <EditorLayoutNodeView node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`editor-layout-divider editor-layout-divider-${node.direction}`}
              onPointerDown={onDividerPointerDown(i)}
              onPointerMove={onDividerPointerMove}
              onPointerUp={onDividerPointerUp}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function EditorLayoutNodeView({ node }: { node: EditorLayoutNode }) {
  if (node.type === 'leaf') return <EditorGroupPane groupId={node.groupId} />;
  return <SplitNode node={node} />;
}

// Recursively renders editorTabsStore's split tree — an arbitrary number of
// editor groups arranged via nested row/column splits, the same shape VS
// Code's multi-column editor grid reduces to. Fully independent of the
// dock system's own (unrelated) layout tree.
export function EditorLayout() {
  const layout = useEditorTabsStore((s) => s.layout);
  return (
    <div className="editor-layout-root">
      <EditorLayoutNodeView node={layout} />
    </div>
  );
}
