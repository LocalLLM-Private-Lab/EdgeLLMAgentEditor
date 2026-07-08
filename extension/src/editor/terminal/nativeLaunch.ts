// A browser extension has no direct way to start a local OS process — this
// is the one browser-provided channel for it (Native Messaging). Requires
// the one-time registry registration done by
// terminal-host/install-native-messaging-host.bat; see docs/protocol.md.
const NATIVE_HOST_NAME = 'com.m365copilot.terminal_host_launcher';

const RESPONSE_TIMEOUT_MS = 5000;

export type NativeLaunchResult =
  | { status: 'started' }
  | { status: 'already_running' }
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
      if (response?.status === 'started' || response?.status === 'already_running') {
        resolve(response as NativeLaunchResult);
        return;
      }
      resolve({ status: 'error', message: response?.message ?? '不明なエラー' });
    });
  });
}
