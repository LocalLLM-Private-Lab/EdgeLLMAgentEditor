import { marked, type Tokens } from 'marked';
import { v4 as uuid } from 'uuid';

export interface ExtractedCodeBlock {
  id: string;
  language: string | null;
  code: string;
  /** Best-effort guess only — never trusted without user confirmation. */
  suggestedPath?: string;
}

function findPathLikeToken(precedingText: string): string | undefined {
  const inlineCodeMatches = precedingText.match(/`([^`]+)`/g) ?? [];
  for (const match of inlineCodeMatches) {
    const candidate = match.slice(1, -1);
    if (/^[\w.\-/\\]+\.[A-Za-z0-9]+$/.test(candidate)) return candidate;
  }
  return undefined;
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
  const blocks = extractFencedCodeBlocks(markdown);
  if (blocks.length > 0) return blocks;

  const trimmed = markdown.trim();
  if (!trimmed) return [];

  return [{ id: uuid(), language: null, code: trimmed }];
}
