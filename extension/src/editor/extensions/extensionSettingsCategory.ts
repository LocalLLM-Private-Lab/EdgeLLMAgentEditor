// Settings-category id convention for an extension's own configuration
// page inside SettingsModal.tsx — mirrors extensionPanelId.ts's
// `ext:<extensionId>` dock-panel id convention (same shared prefix, but a
// completely separate id space: SettingsCategory and PanelId are never
// compared against each other).
const PREFIX = 'ext:';

export function makeExtensionSettingsCategory(extensionId: string): string {
  return `${PREFIX}${extensionId}`;
}

export function parseExtensionSettingsCategory(category: string): string | null {
  return category.startsWith(PREFIX) ? category.slice(PREFIX.length) : null;
}
