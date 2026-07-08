import { get, set, del } from 'idb-keyval';

const ROOT_HANDLE_KEY = 'workspace:rootHandle';

export async function saveWorkspaceHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await set(ROOT_HANDLE_KEY, handle);
}

export async function loadSavedWorkspaceHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return get<FileSystemDirectoryHandle>(ROOT_HANDLE_KEY);
}

export async function clearSavedWorkspaceHandle(): Promise<void> {
  await del(ROOT_HANDLE_KEY);
}
