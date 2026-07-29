'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Any property access on the shim that isn't explicitly implemented below
// returns one of these instead of `undefined` — a real-world extension
// commonly does `vscode.something.somethingElse(...)` in a chain we never
// anticipated, and a bare `undefined` would throw "cannot read property of
// undefined" a level up. A callable/constructible/chainable no-op absorbs
// that instead of crashing activate(), at the cost of quietly doing
// nothing — every call is logged so it's visible, not silent.
function makeNoopProxy(label, onLog) {
  const target = function noop() {
    onLog('warn', `[vscode-shim] stub called: ${label}(...)`);
    return undefined;
  };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return makeNoopProxy(`${label}.${String(prop)}`, onLog);
    },
    apply() {
      onLog('warn', `[vscode-shim] stub called: ${label}(...)`);
      return makeNoopProxy(`${label}()`, onLog);
    },
    construct() {
      onLog('warn', `[vscode-shim] stub constructed: new ${label}(...)`);
      return {};
    },
  });
}

// Same idea as makeNoopProxy, one level down: `window`/`commands`/
// `workspace` are hand-implemented objects with a handful of real methods,
// not the whole API surface. Without this, a call to something real VS
// Code has but we don't (e.g. `window.createStatusBarItem`) hits a plain
// `undefined` and throws "is not a function" instead of safely no-oping —
// exactly the crash makeNoopProxy exists to prevent, just one property
// access deeper than it reaches on its own.
function withNoopFallback(realObject, label, onLog) {
  return new Proxy(realObject, {
    get(target, prop) {
      if (prop in target) {
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return makeNoopProxy(`${label}.${String(prop)}`, onLog);
    },
  });
}

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) this._fn();
  }
  static from(...items) {
    return new Disposable(() => {
      for (const item of items) {
        if (item && typeof item.dispose === 'function') item.dispose();
      }
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
  }
  get event() {
    return (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(data) {
    for (const listener of this._listeners) listener(data);
  }
  dispose() {
    this._listeners.clear();
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
    this.path = fsPath;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  with(change) {
    return new Uri(change && change.path ? change.path : this.fsPath);
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  static parse(value) {
    return new Uri(value.startsWith('file://') ? value.slice('file://'.length) : value);
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

class FileSystemError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
  }
  static FileNotFound(uri) {
    return new FileSystemError(`File not found: ${uri && uri.fsPath}`, 'FileNotFound');
  }
}

// Real `fs` calls against this process's own cwd — no browser/OPFS bridge
// needed here, because terminal-host spawns this process (see
// ext_host.rs's `ExtHostProcess::spawn`) without overriding its working
// directory, so it inherits terminal-host's own cwd, which by this whole
// project's established convention already *is* the workspace root. An
// extension reading/writing `vscode.workspace.fs` is therefore just doing
// normal, unmediated disk I/O — exactly like the real vscode.workspace.fs
// does relative to the real workspace.
function createWorkspaceFs(onLog) {
  return {
    async readFile(uri) {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch (err) {
        if (err.code === 'ENOENT') throw FileSystemError.FileNotFound(uri);
        throw err;
      }
    },
    async writeFile(uri, content) {
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, Buffer.from(content));
    },
    async readDirectory(uri) {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : entry.isSymbolicLink() ? FileType.SymbolicLink : FileType.File,
      ]);
    },
    async createDirectory(uri) {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri, options) {
      await fsp.rm(uri.fsPath, { recursive: !!(options && options.recursive), force: true });
    },
    async rename(source, target, options) {
      if (!(options && options.overwrite)) {
        try {
          await fsp.access(target.fsPath);
          throw new Error(`File already exists: ${target.fsPath}`);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      await fsp.rename(source.fsPath, target.fsPath);
    },
    async copy(source, target, options) {
      await fsp.cp(source.fsPath, target.fsPath, { recursive: true, force: !!(options && options.overwrite) });
    },
    async stat(uri) {
      try {
        const stats = await fsp.stat(uri.fsPath);
        return {
          type: stats.isDirectory() ? FileType.Directory : stats.isSymbolicLink() ? FileType.SymbolicLink : FileType.File,
          ctime: stats.ctimeMs,
          mtime: stats.mtimeMs,
          size: stats.size,
        };
      } catch (err) {
        if (err.code === 'ENOENT') throw FileSystemError.FileNotFound(uri);
        throw err;
      }
    },
  };
}

// One webview's `vscode.Webview` object — shared shape for both
// `window.registerWebviewViewProvider` and `window.createWebviewPanel`.
// `.html`'s setter and `.postMessage()` both push through `send` (the same
// NDJSON stdout channel index.js already uses for log/activated/error) to
// terminal-host, which relays to the browser; see ext_host.rs's stdout
// reader and WebviewHost.tsx on the browser side for the other end of
// this bridge. Incoming (webview → extension) messages arrive back via
// `dispatchWebviewMessage`, called by index.js when it sees a
// `webview_incoming_message` line on stdin.
//
// `toWebviewUri` implements `asWebviewUri`: a webview iframe cannot load
// `file://` URLs at all (browsers refuse it outright, sandboxed or not),
// so a local resource path needs rewriting into an HTTP URL terminal-host
// actually serves — see ws_server.rs's `serve_ext_resource` route. Only a
// path inside the extension's own root can be rewritten (that's the only
// thing that route serves); anything else is handed back unchanged, same
// as a real path this shim simply doesn't understand.
function createWebview(viewId, send, toWebviewUri, webviewOrigin) {
  const receiveEmitter = new EventEmitter();
  let htmlValue = '';
  const webview = {
    options: {},
    cspSource: webviewOrigin || 'vscode-webview:',
    get html() {
      return htmlValue;
    },
    set html(value) {
      htmlValue = value;
      send({ type: 'webview_html', view_id: viewId, html: value });
    },
    async postMessage(message) {
      send({ type: 'webview_message', view_id: viewId, message });
      return true;
    },
    asWebviewUri: toWebviewUri,
    onDidReceiveMessage: receiveEmitter.event,
  };
  return { webview, receiveEmitter };
}

/**
 * Builds the `vscode` module shim handed to an extension's `activate()` in
 * place of the real thing — see terminal-host/extension-host/index.js for
 * how `require('vscode')` gets redirected here. `send` is index.js's own
 * NDJSON-to-stdout function, reused directly so webview updates ride the
 * same channel as log/activated/error events.
 *
 * Returns `{ vscode, dispatchWebviewMessage }` — the latter is how
 * index.js feeds an incoming (webview → extension) message back in,
 * addressed by view id.
 *
 * `extensionId`/`terminalHostPort`/`extensionRoot` (all supplied by
 * index.js from env vars ext_host.rs sets when spawning this process) are
 * only used for `asWebviewUri` — see createWebview's doc comment.
 */
function createVscodeShim({ onLog, onCommandRegistered, send, extensionId, terminalHostPort, extensionRoot, initialConfig }) {
  const commandHandlers = new Map();
  const webviewReceivers = new Map();
  // Only populated for registerWebviewViewProvider views (createWebviewPanel
  // has its own real onDidChangeViewState/visible in VS Code, but nothing
  // in this app drives dock visibility for those — panels, unlike views,
  // aren't tied to a single fixed dock slot) — see
  // applyWebviewVisibilityChange below.
  const webviewViewStates = new Map();

  const webviewOrigin = terminalHostPort ? `http://127.0.0.1:${terminalHostPort}` : undefined;

  // A real user-facing notification (vscode.window.show*Message), distinct
  // from onLog: onLog covers output-channel appends and internal shim
  // warnings that have no UI surface in this app, whereas a notification
  // is meant to actually be seen — see ExtensionNotifications.tsx on the
  // browser side for where this lands.
  function notify(level, message) {
    send({ type: 'notification', level, message });
  }

  // vscode.window.showOpenDialog resolvers, keyed by request id — see
  // resolveDialog below, called from index.js when terminal-host writes
  // back a `dialog_result` line (ext_host.rs runs the actual native
  // dialog; this process never touches the OS UI directly).
  const pendingDialogs = new Map();
  let dialogCounter = 0;

  function resolveDialog(requestId, paths) {
    const resolve = pendingDialogs.get(requestId);
    if (!resolve) return;
    pendingDialogs.delete(requestId);
    resolve(paths && paths.length > 0 ? paths.map((p) => Uri.file(p)) : undefined);
  }

  // vscode.window.showQuickPick resolvers, keyed by request id. Unlike
  // showOpenDialog, this *does* round-trip through the browser (see
  // resolveQuickPick below) — a quick pick is VS Code's own overlay UI,
  // not something the OS provides, so there's no native dialog to reach
  // for here (see ExtensionQuickPick.tsx on the browser side). Keeps the
  // *original* item objects (not the JSON-safe copy sent for display) so
  // resolving returns exactly what the extension handed in, preserving
  // any extra fields (e.g. this project's `key`) untouched by the
  // round-trip.
  const pendingQuickPicks = new Map();
  let quickPickCounter = 0;

  function resolveQuickPick(requestId, selectedIndex) {
    const pending = pendingQuickPicks.get(requestId);
    if (!pending) return;
    pendingQuickPicks.delete(requestId);
    const { resolve, items, canPickMany } = pending;
    if (selectedIndex === null || selectedIndex === undefined) {
      resolve(undefined);
      return;
    }
    if (canPickMany) {
      const indices = Array.isArray(selectedIndex) ? selectedIndex : [selectedIndex];
      resolve(indices.map((i) => items[i]).filter((item) => item !== undefined));
    } else {
      resolve(items[selectedIndex]);
    }
  }

  function toWebviewUri(uri) {
    if (!terminalHostPort || !extensionRoot || !uri || !uri.fsPath) return uri;
    const relative = path.relative(extensionRoot, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return uri;
    const relativeUrl = relative.split(path.sep).map(encodeURIComponent).join('/');
    const url = `${webviewOrigin}/ext-resource/${encodeURIComponent(extensionId)}/${relativeUrl}`;
    return {
      scheme: 'https',
      fsPath: url,
      path: url,
      toString: () => url,
      with(change) {
        return toWebviewUri({ fsPath: change && change.path ? change.path : uri.fsPath });
      },
    };
  }

  const commands = {
    registerCommand(id, callback, thisArg) {
      commandHandlers.set(id, thisArg ? callback.bind(thisArg) : callback);
      onCommandRegistered(id);
      return new Disposable(() => commandHandlers.delete(id));
    },
    registerTextEditorCommand(id, callback, thisArg) {
      return commands.registerCommand(id, callback, thisArg);
    },
    async executeCommand(id, ...args) {
      const handler = commandHandlers.get(id);
      if (handler) return handler(...args);
      // A handful of built-in VS Code commands (not something any
      // extension registers itself) are common enough to be worth a
      // specific, honest response instead of a silent no-op — extensions
      // frequently wire a "settings" button straight to this one.
      if (id === 'workbench.action.openSettings') {
        send({ type: 'open_settings', filter: typeof args[0] === 'string' && args[0] ? args[0] : null });
        return undefined;
      }
      onLog('warn', `executeCommand: no handler registered for "${id}"`);
      return undefined;
    },
    getCommands() {
      return Promise.resolve([...commandHandlers.keys()]);
    },
  };

  function registerWebview(viewId) {
    const { webview, receiveEmitter } = createWebview(viewId, send, toWebviewUri, webviewOrigin);
    webviewReceivers.set(viewId, receiveEmitter);
    return webview;
  }

  const window = {
    showInformationMessage(message) {
      notify('info', message);
      return Promise.resolve(undefined);
    },
    showWarningMessage(message) {
      notify('warn', message);
      return Promise.resolve(undefined);
    },
    showErrorMessage(message) {
      notify('error', message);
      return Promise.resolve(undefined);
    },
    createOutputChannel(name) {
      return {
        name,
        append: (value) => onLog('info', `[${name}] ${value}`),
        appendLine: (value) => onLog('info', `[${name}] ${value}`),
        clear() {},
        show() {},
        hide() {},
        dispose() {},
      };
    },
    // Runs a *native* OS file/folder picker via terminal-host (see
    // ext_host.rs's `run_open_dialog`) rather than anything in-browser —
    // a browser File System Access picker can't hand back a real absolute
    // path, which extensions that persist the result as a filesystem path
    // (e.g. an SSH key location) require. Only ever fired by a command the
    // user explicitly triggered (a settings link, a command palette
    // entry), matching the same safety property lsp-host's own native
    // folder picker relies on.
    showOpenDialog(options) {
      return new Promise((resolve) => {
        const requestId = `dlg-${extensionId}-${dialogCounter++}`;
        pendingDialogs.set(requestId, resolve);
        send({
          type: 'show_open_dialog',
          request_id: requestId,
          options: {
            title: options && options.title,
            canSelectFiles: !options || options.canSelectFiles !== false,
            canSelectFolders: !!(options && options.canSelectFolders),
            canSelectMany: !!(options && options.canSelectMany),
            defaultPath: options && options.defaultUri && options.defaultUri.fsPath,
            filters: options && options.filters,
          },
        });
      });
    },
    // A real, interactive in-app picker — see ExtensionQuickPick.tsx.
    // `items` may itself be a Thenable (VS Code's real signature allows
    // this — an extension computing the list asynchronously), so it's
    // awaited before anything is sent. Only the JSON-safe display fields
    // go over the wire; the original item objects stay here and get
    // looked back up by index once the user picks one (see
    // resolveQuickPick above), so extra fields the browser has no reason
    // to understand (this project's `key`, say) survive intact.
    async showQuickPick(items, options) {
      const resolvedItems = await items;
      const list = Array.isArray(resolvedItems) ? resolvedItems : [];
      return new Promise((resolve) => {
        const requestId = `qp-${extensionId}-${quickPickCounter++}`;
        const canPickMany = !!(options && options.canPickMany);
        pendingQuickPicks.set(requestId, { resolve, items: list, canPickMany });
        const displayItems = list.map((item) =>
          typeof item === 'string' ? { label: item } : { label: item.label, description: item.description, detail: item.detail },
        );
        send({
          type: 'show_quick_pick',
          request_id: requestId,
          items: displayItems,
          placeHolder: (options && options.placeHolder) || null,
          canPickMany,
        });
      });
    },
    // Real bridge to the browser (see WebviewHost.tsx) via the sandboxed
    // iframe in extension/src/editor/webview-sandbox/ — the extension's
    // webview HTML actually renders and its postMessage traffic actually
    // flows both ways.
    registerWebviewViewProvider(viewId, provider) {
      const webview = registerWebview(viewId);
      const visibilityEmitter = new EventEmitter();
      const webviewView = {
        webview,
        visible: true,
        title: undefined,
        description: undefined,
        // Real VS Code reveals the view's own container in the sidebar/panel;
        // here there's no such stack to reveal into — just ask the browser
        // to make this webview's dock panel the shown one (see
        // extensionHostClient.ts's `ext_host_show_webview` handling).
        show() {
          send({ type: 'show_webview', view_id: viewId });
        },
        onDidDispose: new EventEmitter().event,
        onDidChangeVisibility: visibilityEmitter.event,
      };
      webviewViewStates.set(viewId, {
        setVisible(visible) {
          if (webviewView.visible === visible) return;
          webviewView.visible = visible;
          visibilityEmitter.fire();
        },
      });
      const token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event };
      Promise.resolve(provider.resolveWebviewView(webviewView, { state: undefined }, token)).catch((err) =>
        onLog('error', `resolveWebviewView threw: ${err.stack || err.message}`),
      );
      return new Disposable(() => {
        webviewReceivers.delete(viewId);
        webviewViewStates.delete(viewId);
      });
    },
    createWebviewPanel(viewType, title) {
      const viewId = `${viewType}-${Math.random().toString(36).slice(2, 10)}`;
      const webview = registerWebview(viewId);
      const viewStateEmitter = new EventEmitter();
      const panel = {
        webview,
        title,
        viewType,
        visible: true,
        active: true,
        onDidDispose: new EventEmitter().event,
        onDidChangeViewState: viewStateEmitter.event,
        // Same idea as WebviewView.show() above — there's no real panel
        // group to reveal into, just the one dock panel this became.
        reveal() {
          send({ type: 'show_webview', view_id: viewId });
        },
        dispose() {
          webviewReceivers.delete(viewId);
          webviewViewStates.delete(viewId);
        },
      };
      webviewViewStates.set(viewId, {
        setVisible(visible) {
          if (panel.visible === visible) return;
          panel.visible = visible;
          panel.active = visible;
          // Real VS Code's WebviewPanel.onDidChangeViewState fires with
          // `{ webviewPanel }`, unlike WebviewView.onDidChangeVisibility
          // (no payload — extensions read `.visible` themselves instead).
          viewStateEmitter.fire({ webviewPanel: panel });
        },
      });
      return panel;
    },
    activeTextEditor: undefined,
    visibleTextEditors: [],
  };

  // Seeded from the browser's own persisted settings (chrome.storage —
  // this process itself is thrown away on every deactivate, so it has no
  // durable storage of its own) — see index.js's M365CE_INITIAL_CONFIG.
  // Kept in sync both ways afterward: browser edits arrive via
  // applyExternalConfigUpdate, and the extension's own update() calls are
  // echoed back up (see below) so the browser's settings UI stays current.
  const configValues = { ...(initialConfig || {}) };
  const configChangeEmitter = new EventEmitter();

  function fireConfigChange(fullKey) {
    configChangeEmitter.fire({
      affectsConfiguration: (section) => fullKey === section || fullKey.startsWith(`${section}.`),
    });
  }

  const workspace = {
    getConfiguration(section) {
      const prefix = section ? `${section}.` : '';
      return {
        get(key, defaultValue) {
          const full = prefix + key;
          return Object.prototype.hasOwnProperty.call(configValues, full) ? configValues[full] : defaultValue;
        },
        update(key, value) {
          const full = prefix + key;
          configValues[full] = value;
          fireConfigChange(full);
          // The extension changed its own setting (as opposed to a
          // browser-driven edit, which already knows what it just set) —
          // let the browser's settings UI/persistence pick it up too.
          send({ type: 'config_changed', key: full, value });
          return Promise.resolve();
        },
        has(key) {
          return Object.prototype.hasOwnProperty.call(configValues, prefix + key);
        },
      };
    },
    // See createWorkspaceFs's doc comment: this process's own cwd already
    // *is* the workspace root, so these are direct, real fs calls.
    fs: createWorkspaceFs(onLog),
    workspaceFolders: [{ uri: Uri.file(process.cwd()), name: path.basename(process.cwd()), index: 0 }],
    onDidChangeConfiguration: configChangeEmitter.event,
    onDidChangeWorkspaceFolders: new EventEmitter().event,
  };

  // Pushed from the browser's settings UI while this extension is active
  // (see ext_host.rs's send_config_update / index.js's `config_update`
  // handler) — applies the change and fires the same event real in-process
  // update() calls do, without echoing back up (the browser already knows
  // what it just set).
  function applyExternalConfigUpdate(key, value) {
    configValues[key] = value;
    fireConfigChange(key);
  }

  const vscodeCore = {
    commands: withNoopFallback(commands, 'vscode.commands', onLog),
    window: withNoopFallback(window, 'vscode.window', onLog),
    workspace: withNoopFallback(workspace, 'vscode.workspace', onLog),
    Uri,
    EventEmitter,
    Disposable,
    FileType,
    FileSystemError,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    version: '1.85.0',
  };

  const vscode = new Proxy(vscodeCore, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return makeNoopProxy(`vscode.${String(prop)}`, onLog);
    },
  });

  function dispatchWebviewMessage(viewId, message) {
    const receiveEmitter = webviewReceivers.get(viewId);
    if (receiveEmitter) receiveEmitter.fire(message);
  }

  // Pushed from the browser whenever this webview's dock panel actually
  // becomes shown/hidden (see ext_host.rs's send_webview_visibility_changed
  // / index.js's `webview_visibility_changed` handler) — updates whichever
  // WebviewView/WebviewPanel this view id belongs to and fires its real
  // visibility event. A no-op for a view id this process never registered
  // (already disposed, or a stale message that lost a race).
  function applyWebviewVisibilityChange(viewId, visible) {
    const state = webviewViewStates.get(viewId);
    if (state) state.setVisible(visible);
  }

  // Runs one of this extension's own registered commands on the browser's
  // behalf — a `command:...` link clicked in the settings UI (see
  // MarkdownDescription.tsx) arrives here via index.js's `execute_command`
  // stdin branch. Reuses the same internal executeCommand a real
  // `vscode.commands.executeCommand` call goes through, so built-ins like
  // `workbench.action.openSettings` behave identically either way.
  async function executeShimCommand(id, args) {
    const argList = Array.isArray(args) ? args : args === undefined || args === null ? [] : [args];
    try {
      await commands.executeCommand(id, ...argList);
    } catch (err) {
      onLog('error', `command "${id}" (from settings link) threw: ${err.stack || err.message}`);
    }
  }

  return {
    vscode,
    dispatchWebviewMessage,
    applyExternalConfigUpdate,
    applyWebviewVisibilityChange,
    executeShimCommand,
    resolveDialog,
    resolveQuickPick,
  };
}

/** Reads a `{key: value}` JSON file into a fresh Map — synchronous (this
 * runs once, before `activate()`, same timing constraint as
 * M365CE_INITIAL_CONFIG: a real extension can read state synchronously
 * during its own activation, so the file has to already be loaded by
 * then). Missing/corrupt files just start empty, same as a fresh install
 * — nothing here should ever throw and abort activation over a state file
 * problem. */
function loadPersistedState(filePath) {
  const map = new Map();
  if (!filePath) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) map.set(key, value);
  } catch {
    // Doesn't exist yet, or isn't valid JSON — start empty.
  }
  return map;
}

/** Whole-map rewrite on every `update()` — state files here are small
 * (settings, session lists), so this trades a little redundant I/O for not
 * needing any diffing/batching logic. Best-effort: a failed write is
 * logged, not thrown, so a transient disk issue can't crash the extension
 * over something as low-stakes as this. */
async function persistState(filePath, map, onLog) {
  if (!filePath) return;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch (err) {
    onLog('warn', `failed to persist extension state to ${filePath}: ${err.message}`);
  }
}

/** Turns an arbitrary real path into a safe single path segment — used to
 * give each workspace its own workspaceState file without needing a real
 * hashing dependency (collisions are physically impossible for realistic
 * path lengths given every character survives, just re-escaped). */
function sanitizePathForFilename(p) {
  return p.replace(/[:\\/]/g, '_');
}

/** `stateDir` is `undefined` pre-this-feature callers / a future missing
 * env var — everything degrades to the old in-memory-only Maps rather
 * than throwing, so a state-persistence problem never blocks activation
 * entirely. See ext_host.rs's `extension_state_dir` / index.js's
 * `M365CE_STATE_DIR` for where this comes from: deliberately a location
 * `ExtHostInstall`'s reinstall wipe never touches, so a simple
 * update/reinstall doesn't silently erase an extension's saved state
 * (chat history, settings, ...) the way it used to when both
 * `globalState`/`workspaceState` were nothing but a `new Map()` that died
 * with the Node process on every single deactivate. */
function createExtensionContext(extensionRoot, stateDir, onLog) {
  const globalStatePath = stateDir ? path.join(stateDir, 'global-state.json') : null;
  // Scoped by the *actual* workspace root (process.cwd() — correct now
  // that ext_host.rs's spawn sets it from workspaceRealPath, see
  // ExtHostActivate's own doc comment) so different projects don't share
  // history/settings, matching real VS Code's own per-workspace Memento.
  const workspaceStatePath = stateDir
    ? path.join(stateDir, 'workspace-state', `${sanitizePathForFilename(process.cwd())}.json`)
    : null;

  const globalState = loadPersistedState(globalStatePath);
  const workspaceState = loadPersistedState(workspaceStatePath);

  const mapState = (store, filePath) => ({
    get: (key, defaultValue) => (store.has(key) ? store.get(key) : defaultValue),
    update: (key, value) => {
      store.set(key, value);
      return persistState(filePath, store, onLog);
    },
    keys: () => [...store.keys()],
  });

  return {
    subscriptions: [],
    extensionPath: extensionRoot,
    extensionUri: Uri.file(extensionRoot),
    globalState: mapState(globalState, globalStatePath),
    workspaceState: mapState(workspaceState, workspaceStatePath),
    globalStoragePath: extensionRoot,
    logPath: extensionRoot,
    extensionMode: 2,
  };
}

module.exports = { createVscodeShim, createExtensionContext };
