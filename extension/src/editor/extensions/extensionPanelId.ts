// Dock panel id convention for an extension-provided webview — see
// dockStore.ts's PanelId (widened to plain `string` to accommodate these
// dynamically-registered ids alongside the fixed built-in panels).
const PREFIX = 'ext:';

export function makeExtensionPanelId(extensionId: string, viewId: string): string {
  return `${PREFIX}${extensionId}:${viewId}`;
}

export function parseExtensionPanelId(id: string): { extensionId: string; viewId: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  return { extensionId: rest.slice(0, sep), viewId: rest.slice(sep + 1) };
}
