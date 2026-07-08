/** Thin wrapper around chrome.storage.local for the common "one typed
 * value per key" pattern used by several stores (terminal settings, run
 * commands, panel UI state), so each store doesn't hand-roll its own
 * get/set-with-typed-fallback. */
export async function getStoredValue<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

export async function setStoredValue<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
