import type { ResizeHandleProps } from '../hooks/useResizable';
import './ResizeHandle.css';

interface Props extends ResizeHandleProps {
  axis: 'x' | 'y';
}

export function ResizeHandle({ axis, ...handleProps }: Props) {
  return <div className={`resize-handle resize-handle-${axis}`} {...handleProps} />;
}
