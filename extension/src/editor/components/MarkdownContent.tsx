import type { ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import './MarkdownContent.css';

// A deliberately bounded Markdown renderer for content this app doesn't
// control (an installed extension's own readme.md — see
// ExtensionDetailView.tsx) — NEVER uses `dangerouslySetInnerHTML`.
// `marked.parse()`'s raw HTML output would otherwise be a real XSS vector
// for a malicious extension's readme; walking `marked.lexer()`'s token
// tree into React elements instead means every piece of text still goes
// through React's normal escaping, so there's no HTML-injection path at
// all, regardless of what the extension wrote. Covers headings/
// paragraphs/code/lists/bold/italic/links/hr — not full CommonMark (no
// tables, footnotes, nested blockquotes, ...) and images render as their
// alt text only (no mechanism here to resolve a relative path back into
// the extension's own archive).

function renderInline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'text':
      case 'escape': {
        const t = token as Tokens.Text;
        return t.tokens ? <span key={key}>{renderInline(t.tokens, key)}</span> : <span key={key}>{t.text}</span>;
      }
      case 'strong':
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline((token as Tokens.Em).tokens, key)}</em>;
      case 'codespan':
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case 'br':
        return <br key={key} />;
      case 'del':
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, key)}</del>;
      case 'link': {
        const t = token as Tokens.Link;
        return (
          <a key={key} href={t.href} target="_blank" rel="noreferrer">
            {renderInline(t.tokens, key)}
          </a>
        );
      }
      case 'image': {
        // No way to resolve a relative path back into the extension's own
        // archive from here — shown as alt text so the content isn't
        // silently dropped.
        const t = token as Tokens.Image;
        return <span key={key}>[{t.text || t.href}]</span>;
      }
      default:
        return <span key={key}>{'raw' in token ? token.raw : ''}</span>;
    }
  });
}

function renderBlocks(tokens: Token[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  tokens.forEach((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        const Tag = (`h${Math.min(t.depth, 6)}` as unknown) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        nodes.push(<Tag key={key}>{renderInline(t.tokens, key)}</Tag>);
        break;
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph;
        nodes.push(<p key={key}>{renderInline(t.tokens, key)}</p>);
        break;
      }
      case 'code': {
        const t = token as Tokens.Code;
        nodes.push(
          <pre key={key}>
            <code>{t.text}</code>
          </pre>,
        );
        break;
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote;
        nodes.push(<blockquote key={key}>{renderBlocks(t.tokens, key)}</blockquote>);
        break;
      }
      case 'list': {
        const t = token as Tokens.List;
        const ListTag = t.ordered ? 'ol' : 'ul';
        nodes.push(
          <ListTag key={key}>
            {t.items.map((item: Tokens.ListItem, itemIndex: number) => (
              <li key={`${key}-${itemIndex}`}>{renderBlocks(item.tokens, `${key}-${itemIndex}`)}</li>
            ))}
          </ListTag>,
        );
        break;
      }
      case 'hr':
        nodes.push(<hr key={key} />);
        break;
      case 'space':
        break;
      case 'text': {
        // A loose text token appears inside list items — marked sometimes
        // keeps them un-wrapped in a paragraph.
        const t = token as Tokens.Text;
        nodes.push(<span key={key}>{t.tokens ? renderInline(t.tokens, key) : t.text}</span>);
        break;
      }
      default:
        break;
    }
  });
  return nodes;
}

export function MarkdownContent({ text }: { text: string }) {
  const tokens = marked.lexer(text);
  return <div className="markdown-content">{renderBlocks(tokens, 'md')}</div>;
}
