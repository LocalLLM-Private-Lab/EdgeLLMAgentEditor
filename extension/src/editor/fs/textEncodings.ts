import * as Encoding from 'encoding-japanese';

export type TextEncodingId = 'utf-8' | 'utf-8-bom' | 'shift_jis' | 'euc-jp' | 'utf-16le' | 'utf-16be';

export const ENCODING_LABELS: Record<TextEncodingId, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM付き',
  shift_jis: 'Shift-JIS',
  'euc-jp': 'EUC-JP',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

export const ALL_ENCODINGS: TextEncodingId[] = [
  'utf-8',
  'utf-8-bom',
  'shift_jis',
  'euc-jp',
  'utf-16le',
  'utf-16be',
];

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/** BOM-only detection — no charset-guessing heuristics. Files without a BOM
 * (the vast majority, including plain-ASCII/UTF-8) are assumed UTF-8; the
 * user can explicitly "reopen with encoding" for anything that guesses
 * wrong (e.g. a BOM-less Shift-JIS file), matching VS Code's own default
 * (auto-detection there is a heuristic too, not something to silently trust
 * for a save path that overwrites the user's file). */
export function detectEncodingFromBytes(bytes: Uint8Array): TextEncodingId {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8-bom';
  if (startsWith(bytes, UTF16LE_BOM)) return 'utf-16le';
  if (startsWith(bytes, UTF16BE_BOM)) return 'utf-16be';
  return 'utf-8';
}

function stripBom(bytes: Uint8Array, encoding: TextEncodingId): Uint8Array {
  const bomLength =
    encoding === 'utf-8-bom' ? UTF8_BOM.length : encoding === 'utf-16le' || encoding === 'utf-16be' ? 2 : 0;
  return bomLength > 0 ? bytes.subarray(bomLength) : bytes;
}

const DECODER_LABEL: Record<TextEncodingId, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  shift_jis: 'shift_jis',
  'euc-jp': 'euc-jp',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

export function decodeBytes(bytes: Uint8Array, encoding: TextEncodingId): string {
  const body = stripBom(bytes, encoding);
  // Native TextDecoder covers every encoding we support for reading —
  // Shift-JIS/EUC-JP/UTF-16 decode is part of the WHATWG Encoding Standard
  // and needs no third-party library.
  return new TextDecoder(DECODER_LABEL[encoding]).decode(body);
}

function encodeUtf16(text: string, littleEndian: boolean, withBom: boolean): Uint8Array<ArrayBuffer> {
  const bomUnits = withBom ? 1 : 0;
  const out = new Uint8Array((text.length + bomUnits) * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  if (withBom) {
    view.setUint16(offset, 0xfeff, littleEndian);
    offset += 2;
  }
  for (let i = 0; i < text.length; i++) {
    view.setUint16(offset, text.charCodeAt(i), littleEndian);
    offset += 2;
  }
  return out;
}

/** Encodes `text` for writing to disk. UTF-8/UTF-8-BOM/UTF-16 use only
 * native TextEncoder/DataView. Shift-JIS/EUC-JP need encoding-japanese —
 * the browser's built-in TextEncoder can only ever produce UTF-8 output
 * (a WHATWG spec limitation, not a bug), so there is no native way to
 * encode to a legacy Japanese charset. */
export function encodeString(text: string, encoding: TextEncodingId): Uint8Array<ArrayBuffer> {
  switch (encoding) {
    case 'utf-8':
      return new TextEncoder().encode(text);
    case 'utf-8-bom': {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(UTF8_BOM.length + body.length);
      out.set(UTF8_BOM, 0);
      out.set(body, UTF8_BOM.length);
      return out;
    }
    case 'utf-16le':
      return encodeUtf16(text, true, true);
    case 'utf-16be':
      return encodeUtf16(text, false, true);
    case 'shift_jis':
    case 'euc-jp': {
      const to = encoding === 'shift_jis' ? 'SJIS' : 'EUCJP';
      const codes = Encoding.convert(Encoding.stringToCode(text), { to, from: 'UNICODE' });
      return new Uint8Array(codes as number[]);
    }
  }
}
