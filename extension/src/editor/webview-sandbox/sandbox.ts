// Runs inside this extension's MV3 "sandboxed page" (see
// manifest.config.ts's `sandbox.pages` entry) — the platform-sanctioned
// place to run less-trusted HTML/JS: a Chrome extension sandboxed page
// gets the browser's relaxed default CSP (inline scripts, `eval`) in
// exchange for losing all `chrome.*` extension API access, which is
// exactly the isolation boundary a third-party VS Code extension's
// webview content should have. A normal extension page (top-level app)
// cannot do this — its CSP flatly disallows both, no override possible.
//
// This page itself only bridges postMessage between the top-level app
// (its parent) and a nested `srcdoc` iframe holding the extension's
// actual webview HTML — it never touches that content directly.

const iframe = document.getElementById('content') as HTMLIFrameElement;

function buildThemeStyle(themeVars: Record<string, string>): string {
  const decls = Object.entries(themeVars)
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n    ');
  return `<style>\n  :root {\n    ${decls}\n  }\n</style>`;
}

// Injected at the very start of whatever HTML the extension supplies.
// VS Code always makes `acquireVsCodeApi()` available as a global inside
// a webview; the extension calls it once and uses the returned handle to
// talk back. Also re-dispatches extension-bound messages (relayed down
// from the top-level app via this sandbox page) as plain `message`
// events, matching how a real VS Code webview delivers them — the
// extension's own `window.addEventListener('message', ...)` code expects
// `event.data` to be exactly what was sent, not wrapped. A separate
// `theme`-typed relay (see postThemeToWebviewContent) is handled here as
// a CSS variable + class patch only, never as a `message` event — real VS
// Code pushes theme changes the same way, not through the webview's own
// message channel.
function buildWebviewShim(themeKind: string): string {
  return `
<script>
  document.documentElement.classList.add('${themeKind}');
  window.acquireVsCodeApi = (() => {
    let called = false;
    let state;
    return () => {
      if (called) throw new Error('acquireVsCodeApi may only be called once');
      called = true;
      return {
        postMessage: (message) => window.parent.postMessage({ source: 'webview-content', message }, '*'),
        getState: () => state,
        setState: (next) => { state = next; return next; },
      };
    };
  })();
  window.addEventListener('message', (event) => {
    // Only the immediate parent (this sandbox page) is a trusted sender —
    // this also excludes the synthetic redispatch below from re-triggering
    // itself, since a dispatchEvent()-created MessageEvent has no source.
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== 'sandbox-host') return;
    if (data.type === 'theme') {
      document.documentElement.classList.remove('vscode-light', 'vscode-dark');
      document.documentElement.classList.add(data.themeKind);
      for (const name in data.themeVars) {
        document.documentElement.style.setProperty(name, data.themeVars[name]);
      }
      return;
    }
    window.dispatchEvent(new MessageEvent('message', { data: data.message }));
  });
</script>
`;
}

function setHtml(html: string, themeVars: Record<string, string>, themeKind: string) {
  iframe.srcdoc = buildThemeStyle(themeVars) + buildWebviewShim(themeKind) + html;
}

function postToWebviewContent(message: unknown) {
  iframe.contentWindow?.postMessage({ source: 'sandbox-host', message }, '*');
}

function postThemeToWebviewContent(themeVars: Record<string, string>, themeKind: string) {
  iframe.contentWindow?.postMessage({ source: 'sandbox-host', type: 'theme', themeVars, themeKind }, '*');
}

window.addEventListener('message', (event) => {
  if (event.source === window.parent) {
    const data = event.data as {
      type?: string;
      html?: string;
      message?: unknown;
      themeVars?: Record<string, string>;
      themeKind?: string;
    };
    if (data?.type === 'set-html' && typeof data.html === 'string' && data.themeVars && data.themeKind) {
      setHtml(data.html, data.themeVars, data.themeKind);
    } else if (data?.type === 'to-webview') {
      postToWebviewContent(data.message);
    } else if (data?.type === 'set-theme' && data.themeVars && data.themeKind) {
      postThemeToWebviewContent(data.themeVars, data.themeKind);
    }
    return;
  }
  if (event.source === iframe.contentWindow) {
    const data = event.data as { source?: string; message?: unknown };
    if (data?.source === 'webview-content') {
      window.parent.postMessage({ type: 'from-webview', message: data.message }, '*');
    }
  }
});

window.parent.postMessage({ type: 'sandbox-ready' }, '*');
