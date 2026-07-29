// A browser extension has no direct way to start a local OS process — this
// is the one browser-provided channel for it (Native Messaging). Requires
// the one-time registry registration done by
// `node setup/setup.js`; see docs/protocol.md.
const NATIVE_HOST_NAME = 'com.m365copilot.terminal_host_launcher';

// The host may need to wait for the freshly spawned server to actually
// bind its listener before responding (see native_messaging.rs's
// wait_for_listening_port) — a bit more generous than a "is this host even
// installed" check needs, so the extension isn't left retrying itself.
const RESPONSE_TIMEOUT_MS = 10000;

export type NativeLaunchResult =
  | { status: 'started'; port: number; token: string }
  | { status: 'already_running'; port: number; token: string }
  | { status: 'unavailable'; message: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

export function launchTerminalHostViaNativeMessaging(): Promise<NativeLaunchResult> {
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
        resolve(response as NativeLaunchResult);
        return;
      }
      resolve({ status: 'error', message: response?.message ?? '不明なエラー' });
    });
  });
}
