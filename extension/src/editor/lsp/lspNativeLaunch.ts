// A browser extension has no direct way to start a local OS process — this
// is the one browser-provided channel for it (Native Messaging). Requires
// the one-time registry registration done by
// `node setup/setup.js`; see docs/lsp_protocol.md.
//
// Unlike extension/src/editor/terminal/nativeLaunch.ts, the response also
// carries `port`/`token` (see lsp-host/src/native_messaging.rs), so the
// caller can connect immediately without a manual settings step — LSP
// status is meant to transition on its own in the status bar.
const NATIVE_HOST_NAME = 'com.edgellmagenteditor.lsp_host';

// The host may need to bind an OS-assigned loopback port and wait until the
// detached server has published/started listening on it.
const RESPONSE_TIMEOUT_MS = 15000;

export type LspNativeLaunchResult =
  | { status: 'started'; port: number; token: string }
  | { status: 'already_running'; port: number; token: string }
  | { status: 'unavailable'; message: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

export function launchLspHostViaNativeMessaging(): Promise<LspNativeLaunchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timeout' });
    }, RESPONSE_TIMEOUT_MS);

    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { cmd: 'start' }, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (chrome.runtime.lastError) {
        resolve({ status: 'unavailable', message: chrome.runtime.lastError.message ?? '' });
        return;
      }
      if (
        (response?.status === 'started' || response?.status === 'already_running') &&
        typeof response.port === 'number' &&
        typeof response.token === 'string'
      ) {
        resolve(response as LspNativeLaunchResult);
        return;
      }
      resolve({ status: 'error', message: response?.message ?? 'Unknown error' });
    });
  });
}

// No response timeout beyond a generous safety net: the user may spend a
// while browsing in the native folder dialog before picking or cancelling,
// so this must not race a normal-length interaction.
const PICK_FOLDER_TIMEOUT_MS = 5 * 60 * 1000;

export type LspPickFolderResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; message: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

/** Opens a native Windows folder-picker dialog via lsp-host
 * (`native_messaging.rs::handle_pick_folder`) and resolves with the chosen
 * absolute path — lets the user set the LSP workspace root without typing
 * one by hand. Only ever called in direct response to a user click (see
 * StatusBar.tsx's "フォルダを選択..." button); a *silent, unprompted*
 * background dialog was tried for terminal-host and removed for looking
 * like a hang (docs/protocol.md) — this sidesteps that by construction. */
export function pickLspWorkspaceFolder(): Promise<LspPickFolderResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timeout' });
    }, PICK_FOLDER_TIMEOUT_MS);

    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { cmd: 'pick_folder' }, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (chrome.runtime.lastError) {
        resolve({ status: 'unavailable', message: chrome.runtime.lastError.message ?? '' });
        return;
      }
      if (response?.status === 'cancelled') {
        resolve({ status: 'cancelled' });
        return;
      }
      if (response?.status === 'picked' && typeof response.path === 'string') {
        resolve(response as LspPickFolderResult);
        return;
      }
      resolve({ status: 'error', message: response?.message ?? 'Unknown error' });
    });
  });
}
