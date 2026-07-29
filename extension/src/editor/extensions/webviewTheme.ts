// Best-effort visual parity with VS Code's webview theming convention: real
// extension webviews commonly style themselves via `var(--vscode-*)` CSS
// custom properties (and check a `vscode-light`/`vscode-dark` class on
// <html>/<body>) rather than anything this app controls directly. This maps
// this app's own theme tokens (extension/src/editor/index.css) onto that
// naming convention so unmodified extension HTML picks up matching colors.
// Covers only the handful of variables most webview UIs actually
// reference — not the full VS Code color token set, and no high-contrast
// theme support.

export interface WebviewTheme {
  themeVars: Record<string, string>;
  themeKind: 'vscode-light' | 'vscode-dark';
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function buildWebviewTheme(): WebviewTheme {
  const panelBg = cssVar('--panel-bg');
  const editorBg = cssVar('--editor-bg');
  const textColor = cssVar('--text-color');
  const borderColor = cssVar('--border-color');
  const accentColor = cssVar('--accent-color');
  const accentFg = cssVar('--accent-fg');
  const dangerFg = cssVar('--danger-fg');
  const rowHoverBg = cssVar('--row-hover-bg');

  const themeVars: Record<string, string> = {
    '--vscode-editor-background': editorBg,
    '--vscode-editor-foreground': textColor,
    '--vscode-foreground': textColor,
    '--vscode-sideBar-background': panelBg,
    '--vscode-panel-background': panelBg,
    '--vscode-panel-border': borderColor,
    '--vscode-widget-border': borderColor,
    '--vscode-focusBorder': accentColor,
    '--vscode-button-background': accentColor,
    '--vscode-button-foreground': accentFg,
    '--vscode-button-hoverBackground': accentColor,
    '--vscode-input-background': editorBg,
    '--vscode-input-foreground': textColor,
    '--vscode-input-border': borderColor,
    '--vscode-errorForeground': dangerFg,
    '--vscode-list-hoverBackground': rowHoverBg,
    // Dropdown/menu/popup surfaces — deliberately opaque (panelBg, not
    // anything with alpha). Without these, an extension's own dropdown
    // (e.g. a mode-select menu) commonly falls back to whatever transparent
    // default it ships for "running outside real VS Code", letting content
    // stacked underneath it *within the same webview document* show
    // through and making the menu unreadable — real VS Code's own
    // equivalents are solid for exactly this reason.
    '--vscode-dropdown-background': panelBg,
    '--vscode-dropdown-foreground': textColor,
    '--vscode-dropdown-border': borderColor,
    '--vscode-menu-background': panelBg,
    '--vscode-menu-foreground': textColor,
    '--vscode-menu-border': borderColor,
    '--vscode-menu-selectionBackground': accentColor,
    '--vscode-menu-selectionForeground': accentFg,
    '--vscode-quickInput-background': panelBg,
    '--vscode-quickInput-foreground': textColor,
    '--vscode-editorWidget-background': panelBg,
    '--vscode-editorWidget-border': borderColor,
    '--vscode-editorHoverWidget-background': panelBg,
    '--vscode-editorHoverWidget-border': borderColor,
    '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  };

  const themeKind: WebviewTheme['themeKind'] = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'vscode-dark'
    : 'vscode-light';

  return { themeVars, themeKind };
}
