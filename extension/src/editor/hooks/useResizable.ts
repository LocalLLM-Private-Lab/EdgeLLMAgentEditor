import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { getStoredValue, setStoredValue } from '../../shared/chromeStorage';

interface UseResizableOptions {
  storageKey: string;
  defaultSize: number;
  min: number;
  max: number;
  axis: 'x' | 'y';
  /** +1 if dragging toward increasing clientX/Y should grow the size, -1 if it should shrink it. */
  directionSign: 1 | -1;
}

export interface ResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
}

export function useResizable({
  storageKey,
  defaultSize,
  min,
  max,
  axis,
  directionSign,
}: UseResizableOptions): { size: number; handleProps: ResizeHandleProps } {
  const [size, setSize] = useState(defaultSize);
  const dragStart = useRef<{ pos: number; size: number } | null>(null);

  useEffect(() => {
    void getStoredValue<number>(storageKey).then((saved) => {
      if (typeof saved === 'number') setSize(saved);
    });
  }, [storageKey]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      dragStart.current = { pos: axis === 'x' ? e.clientX : e.clientY, size };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragStart.current) return;
      const pos = axis === 'x' ? e.clientX : e.clientY;
      const delta = (pos - dragStart.current.pos) * directionSign;
      setSize(Math.min(max, Math.max(min, dragStart.current.size + delta)));
    },
    [axis, directionSign, min, max],
  );

  const onPointerUp = useCallback(() => {
    if (!dragStart.current) return;
    dragStart.current = null;
    void setStoredValue(storageKey, size);
  }, [storageKey, size]);

  return { size, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
}
