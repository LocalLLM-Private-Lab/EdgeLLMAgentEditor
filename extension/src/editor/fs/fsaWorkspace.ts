export async function pickWorkspaceFolder(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

export async function queryReadWritePermission(
  handle: FileSystemHandle,
): Promise<PermissionState> {
  return handle.queryPermission({ mode: 'readwrite' });
}

export async function requestReadWritePermission(
  handle: FileSystemHandle,
): Promise<PermissionState> {
  return handle.requestPermission({ mode: 'readwrite' });
}

export async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}

export async function readFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array<ArrayBuffer>> {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function getFileLastModified(handle: FileSystemFileHandle): Promise<number> {
  const file = await handle.getFile();
  return file.lastModified;
}

export async function writeFileText(
  handle: FileSystemFileHandle,
  contents: string,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
  } finally {
    await writable.close();
  }
}

export async function writeFileBytes(
  handle: FileSystemFileHandle,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

export async function createFileEntry(
  parentHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await parentHandle.getFileHandle(name, { create: true });
}

export async function createFolderEntry(
  parentHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await parentHandle.getDirectoryHandle(name, { create: true });
}

export async function removeEntry(
  parentHandle: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean,
): Promise<void> {
  await parentHandle.removeEntry(name, { recursive });
}

/** `FileSystemHandle.move()` isn't in the WICG type package yet (see
 * extension/node_modules/@types/wicg-file-system-access). As of the
 * Chromium tested against here, `move()` exists on FileSystemFileHandle
 * but NOT on FileSystemDirectoryHandle — folders fall back to a manual
 * recursive copy+delete (see renameDirectoryEntry below). Feature-detect
 * rather than assume either way, since this is a moving target. */
interface MovableFileSystemHandle {
  move(newName: string): Promise<void>;
}

export function supportsRename(handle: FileSystemHandle): handle is FileSystemHandle & MovableFileSystemHandle {
  return typeof (handle as unknown as MovableFileSystemHandle).move === 'function';
}

/** Renames a file via the native move() API. */
export async function renameFileEntry(
  handle: FileSystemFileHandle,
  newName: string,
): Promise<void> {
  if (!supportsRename(handle)) {
    throw new Error('お使いのブラウザは名前変更(File System Access API の move())に対応していません');
  }
  await handle.move(newName);
}

/** Copy-paste in place (same folder) or onto an existing name must not
 * silently overwrite — appends " (2)", " (3)", ... like a typical file
 * manager, trying the plain name first. */
export async function uniqueEntryName(
  dir: FileSystemDirectoryHandle,
  desiredName: string,
): Promise<string> {
  const exists = async (name: string): Promise<boolean> => {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      // fall through to directory check
    }
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  };

  if (!(await exists(desiredName))) return desiredName;

  const dotIndex = desiredName.lastIndexOf('.');
  const base = dotIndex > 0 ? desiredName.slice(0, dotIndex) : desiredName;
  const ext = dotIndex > 0 ? desiredName.slice(dotIndex) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
}

export async function copyFileEntry(
  source: FileSystemFileHandle,
  dest: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const file = await source.getFile();
  const destFile = await dest.getFileHandle(name, { create: true });
  const writable = await destFile.createWritable();
  try {
    await writable.write(file);
  } finally {
    await writable.close();
  }
}

/** Recursively copies every entry from `source` into a new directory
 * named `destName` under `destParent`. Sibling entries within a directory
 * are independent I/O, so they copy concurrently; only descending into a
 * subdirectory is sequenced after its own destination folder is created. */
export async function copyDirectoryContents(
  source: FileSystemDirectoryHandle,
  destParent: FileSystemDirectoryHandle,
  destName: string,
): Promise<void> {
  const dest = await destParent.getDirectoryHandle(destName, { create: true });
  const entries: [string, FileSystemHandle][] = [];
  for await (const entry of source.entries()) entries.push(entry);

  await Promise.all(
    entries.map(([name, handle]) =>
      handle.kind === 'file'
        ? copyFileEntry(handle as FileSystemFileHandle, dest, name)
        : copyDirectoryContents(handle as FileSystemDirectoryHandle, dest, name),
    ),
  );
}

/** Renames a directory. Uses the native move() if the browser supports it
 * for directories; otherwise emulates it by copying the whole subtree to
 * a sibling with the new name and deleting the original — Chromium does
 * not (yet) implement FileSystemDirectoryHandle.move(). */
export async function renameDirectoryEntry(
  handle: FileSystemDirectoryHandle,
  parentHandle: FileSystemDirectoryHandle,
  oldName: string,
  newName: string,
): Promise<void> {
  if (supportsRename(handle)) {
    await handle.move(newName);
    return;
  }
  await copyDirectoryContents(handle, parentHandle, newName);
  await parentHandle.removeEntry(oldName, { recursive: true });
}
