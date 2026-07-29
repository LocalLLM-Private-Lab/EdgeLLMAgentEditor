const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

/** Whether `name` is one of the image formats the browser's own `<img>` tag
 * can render directly — these get a dedicated image-viewer tab
 * (ImageViewerPane.tsx) instead of being decoded as text. */
export function imageMimeType(name: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[extensionOf(name)];
}

/** Same heuristic git/most text editors use: a NUL byte anywhere in a
 * leading sample means the file isn't meant to be read as text (real text
 * encodings — UTF-8, UTF-16, Shift-JIS, EUC-JP — never legitimately produce
 * one). Only samples the first chunk since a NUL near the start is enough
 * signal, and scanning a large binary file in full would be wasted work for
 * a file we're probably not going to open as text anyway. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 8192);
  for (let i = 0; i < sampleLength; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
