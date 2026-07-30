import * as Encoding from 'encoding-japanese';

export type TextEncodingId = 'utf-8' | 'utf-8-bom' | 'shift_jis' | 'cp932' | 'euc-jp' | 'utf-16le' | 'utf-16be';

export const ENCODING_LABELS: Record<TextEncodingId, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM付き',
  shift_jis: 'Shift-JIS',
  cp932: 'CP932',
  'euc-jp': 'EUC-JP',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

export const ALL_ENCODINGS: TextEncodingId[] = [
  'utf-8',
  'utf-8-bom',
  'shift_jis',
  'cp932',
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

function isSjisLeadByte(b: number): boolean {
  return (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
}

// CP932 (Windows-31J) is a strict superset of JIS X 0208 Shift-JIS: it adds
// NEC row-13 symbols, NEC-selected IBM extended characters, IBM extended
// characters, and a handful of single-byte code points in Microsoft's Private
// Use Area mappings. These tables are the exact byte-level divergence
// between the two, derived empirically by diffing Python's `shift_jis` and
// `cp932` codecs (which implement the canonical mapping tables) byte-pair by
// byte-pair — there is no authoritative spec text to transcribe this from.
const CP932_ONLY_SINGLE_BYTES = new Set([0x80, 0xa0, 0xfd, 0xfe, 0xff]);

// Lead bytes with zero JIS X 0208 assignments — every second byte in the
// valid range (0x40-0x7e, 0x80-0xfc) is a CP932-only extended character.
const CP932_ONLY_LEAD_BYTES_FULL = new Set([
  0xed, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb,
]);

// Lead bytes that are partially CP932-only: the listed second-byte ranges
// are extended characters, everything else under that lead byte is standard
// JIS X 0208.
const CP932_ONLY_SECOND_BYTE_RANGES = new Map<number, ReadonlyArray<readonly [number, number]>>([
  [0x87, [[0x40, 0x5d], [0x5f, 0x75], [0x7e, 0x7e], [0x80, 0x9c]]], // NEC row 13
  [0xee, [[0x40, 0x7e], [0x80, 0xec], [0xef, 0xfc]]], // IBM extended (partial)
  [0xfc, [[0x40, 0x4b]]], // IBM extended (partial)
]);

function isCp932OnlyPair(lead: number, second: number): boolean {
  if (CP932_ONLY_LEAD_BYTES_FULL.has(lead)) return true;
  const ranges = CP932_ONLY_SECOND_BYTE_RANGES.get(lead);
  return ranges !== undefined && ranges.some(([start, end]) => second >= start && second <= end);
}

// The "wave dash problem" (波ダッシュ問題): six byte pairs JIS X 0208 and
// CP932 both assign, but to *different* Unicode characters. CP932 follows
// Microsoft's fullwidth-punctuation convention — which is what this file's
// CP932 decode (native TextDecoder) already produces — while strict
// Shift-JIS follows the JIS/Unicode-consortium mapping. Verified against
// Python's `shift_jis`/`cp932` codecs, which disagree on exactly these six.
const STRICT_SJIS_CHAR_BY_PAIR = new Map<number, string>([
  [0x8160, '〜'], // WAVE DASH (CP932: U+FF5E FULLWIDTH TILDE)
  [0x8161, '‖'], // DOUBLE VERTICAL LINE (CP932: U+2225 PARALLEL TO)
  [0x817c, '−'], // MINUS SIGN (CP932: U+FF0D FULLWIDTH HYPHEN-MINUS)
  [0x8191, '¢'], // CENT SIGN (CP932: U+FFE0 FULLWIDTH CENT SIGN)
  [0x8192, '£'], // POUND SIGN (CP932: U+FFE1 FULLWIDTH POUND SIGN)
  [0x81ca, '¬'], // NOT SIGN (CP932: U+FFE2 FULLWIDTH NOT SIGN)
]);

// The CP932-flavored counterpart of each character above. Both forms are
// valid input for CP932 encoding (encoding-japanese maps either to the same
// byte pair), but strict Shift-JIS must refuse the CP932 form.
const CP932_ONLY_AMBIGUOUS_CHARS = new Set(['～', '∥', '－', '￠', '￡', '￢']);

// Of the six JIS X 0208 forms, three (WAVE DASH/CENT/POUND) aren't in
// encoding-japanese's SJIS table at all — it only knows their CP932
// counterpart. Substitute before encoding so the byte output is still
// correct; the other three already encode directly to the same byte.
const STRICT_SJIS_ENCODE_SUBSTITUTIONS = new Map<string, string>([
  ['〜', '～'],
  ['¢', '￠'],
  ['£', '￡'],
]);

/** Decodes strict JIS X 0208 Shift-JIS: identical to CP932 except that
 * CP932-only byte sequences are treated as invalid (replaced with U+FFFD),
 * matching how Python's `shift_jis` codec (as opposed to its `cp932` codec)
 * rejects them. Native TextDecoder has no strict-mode option — its
 * "shift_jis" label always decodes the full CP932 superset — so runs of
 * ordinary bytes are decoded natively and CP932-only sequences are spliced
 * out in between. */
function decodeStrictShiftJis(bytes: Uint8Array): string {
  const decoder = new TextDecoder('shift_jis');
  let result = '';
  let runStart = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (isSjisLeadByte(b) && i + 1 < bytes.length) {
      const strictChar = STRICT_SJIS_CHAR_BY_PAIR.get((b << 8) | bytes[i + 1]);
      if (strictChar !== undefined) {
        result += decoder.decode(bytes.subarray(runStart, i)) + strictChar;
        i += 2;
        runStart = i;
        continue;
      }
      if (isCp932OnlyPair(b, bytes[i + 1])) {
        // Only the lead byte is invalid here — the trail byte is a
        // structurally ordinary value, just not paired with this lead byte
        // in JIS X 0208. Re-examine it as a fresh position on the next loop
        // iteration, matching the "resync at next byte" recovery every
        // WHATWG-style multi-byte decoder (and Python's shift_jis codec)
        // uses for an unassigned-but-well-formed sequence.
        result += decoder.decode(bytes.subarray(runStart, i)) + '�';
        i += 1;
        runStart = i;
        continue;
      }
      i += 2;
      continue;
    }
    if (CP932_ONLY_SINGLE_BYTES.has(b)) {
      result += decoder.decode(bytes.subarray(runStart, i)) + '�';
      i += 1;
      runStart = i;
      continue;
    }
    i += 1;
  }
  return result + decoder.decode(bytes.subarray(runStart));
}

/** Removes CP932-only byte sequences from an already CP932-encoded buffer,
 * replacing each with `?` — the same fallback encoding-japanese itself uses
 * for characters it cannot represent at all. Used to turn a CP932 encode
 * result into a strict Shift-JIS one. */
function stripCp932OnlyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (isSjisLeadByte(b) && i + 1 < bytes.length) {
      if (isCp932OnlyPair(b, bytes[i + 1])) {
        out.push(0x3f);
      } else {
        out.push(b, bytes[i + 1]);
      }
      i += 2;
      continue;
    }
    out.push(CP932_ONLY_SINGLE_BYTES.has(b) ? 0x3f : b);
    i += 1;
  }
  return new Uint8Array(out);
}

export function decodeBytes(bytes: Uint8Array, encoding: TextEncodingId): string {
  const body = stripBom(bytes, encoding);
  switch (encoding) {
    case 'shift_jis':
      return decodeStrictShiftJis(body);
    case 'cp932':
      // The WHATWG "shift_jis" decoder is defined using the windows-31j
      // (CP932) index, so decoding via that label already is CP932 decoding.
      return new TextDecoder('shift_jis').decode(body);
    case 'utf-8':
    case 'utf-8-bom':
      return new TextDecoder('utf-8').decode(body);
    case 'euc-jp':
      return new TextDecoder('euc-jp').decode(body);
    case 'utf-16le':
      return new TextDecoder('utf-16le').decode(body);
    case 'utf-16be':
      return new TextDecoder('utf-16be').decode(body);
  }
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
 * native TextEncoder/DataView. Shift-JIS/CP932/EUC-JP need encoding-japanese
 * — the browser's built-in TextEncoder can only ever produce UTF-8 output
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
    case 'euc-jp': {
      const codes = Encoding.convert(Encoding.stringToCode(text), { to: 'EUCJP', from: 'UNICODE' });
      return new Uint8Array(codes as number[]);
    }
    case 'cp932': {
      // encoding-japanese's SJIS table (CP932/Windows-31J — see its
      // config.js alias list) only recognizes the CP932-flavored form of
      // three ambiguous punctuation marks, not the JIS X 0208 form real
      // Japanese input methods often produce (e.g. wave dash U+301C).
      // Substitute so both forms round-trip to the same CP932 byte, the
      // way Microsoft's own cp932 codec accepts either as input.
      let normalized = '';
      for (const ch of text) {
        normalized += STRICT_SJIS_ENCODE_SUBSTITUTIONS.get(ch) ?? ch;
      }
      const codes = Encoding.convert(Encoding.stringToCode(normalized), { to: 'SJIS', from: 'UNICODE' });
      return new Uint8Array(codes as number[]);
    }
    case 'shift_jis': {
      let strictText = '';
      for (const ch of text) {
        strictText += CP932_ONLY_AMBIGUOUS_CHARS.has(ch)
          ? '�' // reject CP932-flavored punctuation up front; forces '?' below
          : (STRICT_SJIS_ENCODE_SUBSTITUTIONS.get(ch) ?? ch);
      }
      const codes = Encoding.convert(Encoding.stringToCode(strictText), { to: 'SJIS', from: 'UNICODE' });
      return stripCp932OnlyBytes(new Uint8Array(codes as number[]));
    }
  }
}
