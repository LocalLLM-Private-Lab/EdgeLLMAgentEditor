'use strict';

// Spawned by terminal-host (see ../src/ext_host.rs) as a plain child
// process, one per activated extension. Talks to terminal-host over plain
// stdin/stdout using newline-delimited JSON (NDJSON) — deliberately not
// Node's own `fork()` IPC channel, since the other end is Rust, not Node.
//
// argv[2] is the extension's on-disk cache root (terminal-host has already
// unzipped it there — see ExtHostInstall in protocol.rs). This process's
// only job: locate package.json + main, shim `require('vscode')`, call
// activate(), report what happened, then stay alive (the extension is
// considered "active") until asked to deactivate.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Module = require('module');
const { createVscodeShim, createExtensionContext } = require('./vscode-shim');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(message) {
  send({ type: 'error', message });
  process.exit(1);
}

const extensionRoot = process.argv[2];
if (!extensionRoot) {
  fail('extension-host: missing extension root directory argument');
}

// vsix layout is `extension/package.json`; also accept a bare
// package.json at the cache root for non-vsix zips (per the plan, this
// host isn't strict about the packaging format, only the manifest shape).
function findManifestPath(root) {
  const candidates = [path.join(root, 'extension', 'package.json'), path.join(root, 'package.json')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('package.json not found (looked in extension/ and the archive root)');
}

let manifest;
let manifestPath;
let mainPath;
try {
  manifestPath = findManifestPath(extensionRoot);
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mainPath = path.resolve(path.dirname(manifestPath), manifest.main || './extension.js');
} catch (err) {
  fail(`extension-host: failed to read package.json: ${err.message}`);
}

// The browser is the source of truth for persisted config (chrome.storage)
// — this process is thrown away on every deactivate, so its own
// configValues always starts from whatever the browser last saved. Passed
// via env var, not a stdin message, so it's already present before
// activate() runs (a message could arrive too late for extensions that
// read config synchronously during activation).
let initialConfig = {};
try {
  const raw = process.env.M365CE_INITIAL_CONFIG;
  if (raw) initialConfig = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch {
  // Malformed/missing — fall back to an empty config rather than failing
  // activation entirely over a persistence-layer glitch.
}

const registeredCommands = [];
const {
  vscode: shim,
  dispatchWebviewMessage,
  applyExternalConfigUpdate,
  applyWebviewVisibilityChange,
  executeShimCommand,
  resolveDialog,
  resolveQuickPick,
} = createVscodeShim({
  onLog: (level, message) => send({ type: 'log', level, message }),
  onCommandRegistered: (id) => registeredCommands.push(id),
  send,
  // Passed by ext_host.rs when spawning this process — see
  // ws_server.rs's `serve_ext_resource` route, which these two values
  // address (asWebviewUri rewrites a `file://` path under the extension's
  // own root into `http://127.0.0.1:<port>/ext-resource/<id>/<relative>`).
  extensionId: process.env.M365CE_EXTENSION_ID || '',
  terminalHostPort: process.env.M365CE_TERMINAL_HOST_PORT || '',
  extensionRoot: path.dirname(manifestPath),
  initialConfig,
});

// The standard technique for running a VS Code extension outside VS Code:
// `vscode` is always declared `external` in a real extension's bundler
// config (VS Code itself provides it at runtime), so every
// `require('vscode')` call reaches Node's real module loader — redirect
// it here instead of letting it throw "Cannot find module 'vscode'".
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return shim;
  return originalLoad.call(this, request, parent, isMain);
};

let extensionModule;
try {
  extensionModule = require(mainPath);
} catch (err) {
  fail(`extension-host: failed to load ${mainPath}: ${err.stack || err.message}`);
}

// The extension's own root is wherever its package.json actually lives —
// for a real vsix that's `<cache root>/extension/`, not the cache root
// itself (which is one level up, holding vsix-level metadata alongside
// it). context.extensionPath needs to be the former: extensions commonly
// resolve their own bundled resources (icons, webview HTML, ...) relative
// to it.
const context = createExtensionContext(
  path.dirname(manifestPath),
  process.env.M365CE_STATE_DIR || undefined,
  (level, message) => send({ type: 'log', level, message }),
);

async function main() {
  try {
    if (typeof extensionModule.activate === 'function') {
      await extensionModule.activate(context);
    }
    send({ type: 'activated', commands: registeredCommands });
  } catch (err) {
    send({ type: 'error', message: `activate() threw: ${err.stack || err.message}` });
    process.exitCode = 1;
    return;
  }

  // Activation succeeded — stay alive (this process IS the running
  // extension) until terminal-host asks for deactivation or just kills us
  // on disconnect, matching how PTY sessions are torn down.
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'deactivate') {
      try {
        if (typeof extensionModule.deactivate === 'function') await extensionModule.deactivate();
      } catch (err) {
        send({ type: 'log', level: 'error', message: `deactivate() threw: ${err.stack || err.message}` });
      }
      process.exit(0);
    } else if (message.type === 'webview_incoming_message') {
      dispatchWebviewMessage(message.view_id, message.message);
    } else if (message.type === 'config_update') {
      applyExternalConfigUpdate(message.key, message.value);
    } else if (message.type === 'execute_command') {
      void executeShimCommand(message.command, message.args);
    } else if (message.type === 'dialog_result') {
      resolveDialog(message.request_id, message.paths);
    } else if (message.type === 'quick_pick_result') {
      resolveQuickPick(message.request_id, message.selected_index);
    } else if (message.type === 'webview_visibility_changed') {
      applyWebviewVisibilityChange(message.view_id, message.visible);
    }
  });
}

void main();
