import { useEffect } from 'react';

/** Calls `onDismiss` when any of `events` fires on the window — used by
 * floating menus/popups (MenuBar's dropdown, the file tree's context
 * menu) to close themselves on an outside click. Callers that render the
 * dismissible element conditionally can just leave `active` at its
 * default of `true`; MenuBar keeps its dropdown mounted regardless of
 * open state, so it passes `active` explicitly. */
export function useDismissOnOutsideClick(
  onDismiss: () => void,
  active = true,
  events: (keyof WindowEventMap)[] = ['click'],
): void {
  useEffect(() => {
    if (!active) return;
    for (const event of events) window.addEventListener(event, onDismiss);
    return () => {
      for (const event of events) window.removeEventListener(event, onDismiss);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss]);
}
