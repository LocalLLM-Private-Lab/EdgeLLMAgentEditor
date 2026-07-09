import { marked, type Tokens } from 'marked';
import { v4 as uuid } from 'uuid';

export interface ExtractedCodeBlock {
  id: string;
  language: string | null;
  code: string;
  /** Best-effort guess only — never trusted without user confirmation. */
  suggestedPath?: string;
}

function isPathLike(candidate: string): boolean {
  // Prefix before the extension is optional so dotfiles (.gitignore, .env)
  // — which have nothing before their leading dot — still match.
  return /^[\w.\-/\\]*\.[A-Za-z0-9]+$/.test(candidate);
}

/** Scans lines closest to the fence first (most likely to actually label
 * *this* block, vs. an unrelated backtick-wrapped mention earlier in a
 * multi-paragraph lead-in), checking inline code first, then headings
 * ("### path") and bold ("**path**") — Copilot doesn't consistently use
 * inline code to label a file per block. */
function findPathLikeToken(precedingText: string): string | undefined {
  const lines = precedingText.split('\n').reverse();
  for (const line of lines) {
    const inlineCodeMatches = line.match(/`([^`]+)`/g) ?? [];
    for (const match of inlineCodeMatches) {
      const candidate = match.slice(1, -1);
      if (isPathLike(candidate)) return candidate;
    }
    const headingOrBold = /^#{1,6}\s+\**(.+?)\**\s*:?\s*$/.exec(line) ?? /^\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (headingOrBold) {
      const candidate = headingOrBold[1].trim();
      if (isPathLike(candidate)) return candidate;
    }
  }
  return undefined;
}

// Matches our own prompt convention: a backtick-wrapped path immediately
// followed by a fence-opening line, e.g. "`README.md`:\n```md\n". The
// prefix before the extension is optional so dotfiles (.gitignore, .env)
// still match.
const PATH_MARKER_RE = /`([^`\n]*\.[A-Za-z0-9]+)`:?[ \t]*\r?\n(`{3,}|~{3,})([^\n]*)\r?\n/g;

interface PathMarker {
  path: string;
  language: string | null;
  fenceChar: string;
  fenceLen: number;
  markerStart: number;
  contentStart: number;
}

function findPathMarkers(markdown: string): PathMarker[] {
  const markers: PathMarker[] = [];
  const re = new RegExp(PATH_MARKER_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown))) {
    const fence = match[2];
    markers.push({
      path: match[1],
      language: match[3].trim().split(/\s/)[0] || null,
      fenceChar: fence[0],
      fenceLen: fence.length,
      markerStart: match.index,
      contentStart: match.index + match[0].length,
    });
  }
  return markers;
}

/**
 * Primary extraction strategy for multi-file responses that follow our
 * prompt convention (path label immediately before each fence). Splits on
 * marker *positions* instead of asking a generic CommonMark parser where
 * each fence closes — critical because when a file's own content contains
 * same-length nested fences (e.g. a README documenting ```bash commands),
 * marked's tokenizer closes the outer block at the *first* matching-length
 * closing fence it finds (spec-correct, but wrong for our purposes), which
 * corrupts not just that block's boundaries but the precedingText used for
 * every later block's path detection too. Finding the *last* matching
 * closing fence before the next marker (rather than the first one found
 * anywhere) sidesteps that ambiguity entirely.
 */
function extractByPathMarkers(markdown: string): ExtractedCodeBlock[] | null {
  const markers = findPathMarkers(markdown);
  if (markers.length === 0) return null;

  return markers.map((marker, i) => {
    const regionEnd = i + 1 < markers.length ? markers[i + 1].markerStart : markdown.length;
    const region = markdown.slice(marker.contentStart, regionEnd);

    const closingRe = new RegExp(`^${marker.fenceChar}{${marker.fenceLen},}[ \\t]*$`, 'gm');
    let lastClose: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = closingRe.exec(region))) lastClose = m;

    const code = (lastClose ? region.slice(0, lastClose.index) : region).replace(/\r?\n$/, '');

    return { id: uuid(), language: marker.language, code, suggestedPath: marker.path };
  });
}

function extractFencedCodeBlocks(markdown: string): ExtractedCodeBlock[] {
  const tokens = marked.lexer(markdown);
  const blocks: ExtractedCodeBlock[] = [];
  let precedingText = '';

  for (const token of tokens) {
    if (token.type === 'code') {
      const codeToken = token as Tokens.Code;
      // CommonMark also treats any 4-space-indented text as a "code"
      // token (codeBlockStyle: 'indented') — practically every
      // programming language's function bodies match that, which would
      // otherwise fragment a fenceless paste into scraps and silently
      // drop the un-indented lines between them. Only ```-fenced blocks
      // are a deliberate "this is code" signal here.
      if (codeToken.codeBlockStyle === 'indented') {
        precedingText = codeToken.raw;
        continue;
      }
      blocks.push({
        id: uuid(),
        language: codeToken.lang?.split(/\s/)[0] || null,
        code: codeToken.text,
        suggestedPath: findPathLikeToken(precedingText),
      });
      precedingText = '';
    } else if ('raw' in token) {
      precedingText = token.raw;
    }
  }

  return blocks;
}

/**
 * Handles two distinct paste shapes: the whole chat reply (prose +
 * ```-fenced blocks, parsed via marked's lexer above) and a code block
 * copied on its own (e.g. via a chat UI's per-block "copy" button, which
 * usually strips the ``` fences and pastes bare source). marked's lexer
 * only recognizes the former — a fenceless paste yields zero "code" tokens
 * since it looks like a paragraph — so when nothing was found but there's
 * non-blank input, treat the whole paste as a single unfenced code block.
 */
export function extractCodeBlocks(markdown: string): ExtractedCodeBlock[] {
  const byMarkers = extractByPathMarkers(markdown);
  if (byMarkers) return byMarkers;

  const blocks = extractFencedCodeBlocks(markdown);
  if (blocks.length > 0) return blocks;

  const trimmed = markdown.trim();
  if (!trimmed) return [];

  return [{ id: uuid(), language: null, code: trimmed }];
}
