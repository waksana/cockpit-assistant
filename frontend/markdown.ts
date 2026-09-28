import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { ReactNode } from 'react';
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';

function entities(text: string): string {
  return text.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]+);/gu, entity => {
    // Only a single entity is parsed, never document content or user-supplied markup.
    if (typeof DOMParser !== 'undefined') return new DOMParser().parseFromString(entity, 'text/html').body.textContent ?? entity;
    if (entity.startsWith('&#')) {
      const number = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
    }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': '\u00a0' } as Record<string, string>)[entity] ?? entity;
  });
}

/** Relative navigation stays on this host; network-path and executable URLs are rejected. */
export function safeHref(value: string): string | null {
  const href = entities(value).trim();
  if (!href || /[\u0000-\u0020\u007f\\]/u.test(href) || href.startsWith('//')) return null;
  if (/^[a-z][a-z\d+.-]*:/iu.test(href)) {
    if (!/^(https?:|mailto:)/iu.test(href)) return null;
    try {
      const url = new URL(href);
      return url.protocol === 'mailto:' || ((url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname)
        ? href : null;
    } catch { return null; }
  }
  try {
    const base = new URL('https://module.invalid/');
    return new URL(href, base).origin === base.origin ? href : null;
  } catch { return null; }
}

export function createMarkdown(context: Pick<ModuleFrontendContext, 'react'>): (text: string) => ReactNode {
  const h = context.react.createElement;
  const render = (tokens: Token[], inLink = false): ReactNode[] => tokens.map((token, key) => {
    const children = () => render('tokens' in token ? token.tokens ?? [] : [], inLink);
    switch (token.type) {
      case 'space': return null;
      case 'heading': {
        const heading = token as Tokens.Heading;
        return h(`h${heading.depth}`, { key }, children());
      }
      case 'paragraph': return h('p', { key }, children());
      case 'text': return token.tokens ? h(context.react.Fragment, { key }, children()) : entities(token.text);
      case 'escape': return token.text;
      case 'strong': return h('strong', { key }, children());
      case 'em': return h('em', { key }, children());
      case 'del': return h('del', { key }, children());
      case 'codespan': return h('code', { key }, token.text);
      case 'code': return h('pre', { key }, h('code', null, token.text));
      case 'br': return h('br', { key });
      case 'hr': return h('hr', { key });
      case 'blockquote': return h('blockquote', { key }, children());
      case 'html': return h('span', { key, className: 'ca-plain-text' }, token.raw);
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        return href && !inLink
          ? h('a', { key, href, title: link.title ? entities(link.title) : undefined, rel: 'noopener noreferrer' }, render(link.tokens, true))
          : h('span', { key }, render(link.tokens, inLink), '（', link.href, '）');
      }
      case 'image': {
        const image = token as Tokens.Image;
        const href = safeHref(image.href);
        const label = `图片：${entities(image.text) || '未提供说明'}`;
        return href && !inLink
          ? h('a', { key, href, title: image.title ?? undefined, rel: 'noopener noreferrer' }, label)
          : h('span', { key }, label, '（', image.href, '）');
      }
      case 'list': {
        const list = token as Tokens.List;
        return h(list.ordered ? 'ol' : 'ul', { key, ...(list.ordered ? { start: Number(list.start) || 1 } : {}) },
          list.items.map((item, index) => h('li', { key: index },
            item.task ? h('span', { className: 'ca-task-state' }, item.checked ? '［已完成］' : '［未完成］') : null,
            render(item.tokens, inLink))));
      }
      case 'list_item': return h('li', { key }, children());
      case 'checkbox': return h('span', { key }, token.checked ? '［已完成］' : '［未完成］');
      case 'table': {
        const table = token as Tokens.Table;
        const cell = (entry: Tokens.TableCell, index: number, heading: boolean) =>
          h(heading ? 'th' : 'td', { key: index, ...(heading ? { scope: 'col' } : {}),
            style: { textAlign: entry.align ?? undefined } }, render(entry.tokens, inLink));
        return h('table', { key },
          h('thead', null, h('tr', null, table.header.map((entry, index) => cell(entry, index, true)))),
          h('tbody', null, table.rows.map((row, index) => h('tr', { key: index },
            row.map((entry, column) => cell(entry, column, false))))));
      }
      case 'def': return null;
      default: return token.raw;
    }
  });
  return text => {
    try { return h('div', { className: 'ca-markdown' }, render(marked.lexer(text, { gfm: true }))); }
    catch {
      return h('div', null, h('p', { role: 'alert', className: 'ck-status-text' }, 'Markdown 无法解析，以下显示完整原文。'),
        h('div', { className: 'ca-plain-text' }, text));
    }
  };
}
