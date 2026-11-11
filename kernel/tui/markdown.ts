import { clip, detab, width, wrap, type Line, type Span } from './text';
import type { Glyphs, Style } from './theme';

// The little markdown a reply is shown with: headings, emphasis, code, lists, quotes, rules and
// links. Line breaks are kept as written. Whatever is not recognised, or is opened and never
// closed, is shown as the text it is.

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/;
const WORD = /[\p{L}\p{N}]/u;

/** One line's inline markup as styled spans. */
export function inline(src: string, base: Style = {}): Span[] {
  const out: Span[] = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') out.push({ text: buf, style: base });
    buf = '';
  };
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (src[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      let close = src.indexOf(fence, i + n);
      // The closing run has to be exactly as long as the opening one.
      while (close !== -1 && src[close + n] === '`') {
        while (src[close + n] === '`') close += 1;
        close = src.indexOf(fence, close + n);
      }
      if (close !== -1) {
        flush();
        out.push({ text: src.slice(i + n, close).replace(/^ (.*) $/, '$1'), style: { ...base, fg: 'code' } });
        i = close + n;
      } else {
        buf += fence;
        i += n;
      }
      continue;
    }
    if (c === '*' || c === '_') {
      let n = 1;
      while (src[i + n] === c && n < 3) n += 1;
      const inner = emphasised(src, i, c, n);
      if (inner !== null) {
        flush();
        out.push(...inline(inner, { ...base, ...(n >= 2 ? { bold: true } : {}), ...(n !== 2 ? { italic: true } : {}) }));
        i += inner.length + 2 * n;
      } else {
        buf += c.repeat(n);
        i += n;
      }
      continue;
    }
    if (c === '[') {
      const m = /^\[([^\]\n]*)\]\(\s*<?([^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        const [whole, label = '', url = ''] = m;
        if (label !== '' && label !== url) out.push(...inline(label, base), { text: ' ', style: base });
        out.push({ text: label !== '' && label !== url ? `(${url})` : url, style: { fg: 'dim' } });
        i += whole.length;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ text: m[1]!, style: { fg: 'dim' } });
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** The text between an opening run of `n` marks at `at` and the run that closes it, or null when nothing does. */
function emphasised(src: string, at: number, mark: string, n: number): string | null {
  const start = at + n;
  const next = src[start];
  if (next === undefined || next === ' ' || next === mark) return null;
  // An underscore inside a word is part of the word: snake_case stays as it is.
  if (mark === '_' && at > 0 && WORD.test(src[at - 1]!)) return null;
  const delim = mark.repeat(n);
  for (let j = src.indexOf(delim, start + 1); j !== -1; j = src.indexOf(delim, j + 1)) {
    if (src[j - 1] === ' ' || src[j - 1] === mark || src[j + n] === mark) continue;
    if (mark === '_' && src[j + n] !== undefined && WORD.test(src[j + n]!)) continue;
    return src.slice(start, j);
  }
  return null;
}

const DIM: Style = { fg: 'dim' };
const CODE: Style = { fg: 'code' };

/** A reply as rows of at most `max` columns. */
export function markdown(text: string, max: number, g: Glyphs): Line[] {
  const out: Line[] = [];
  const blank = () => {
    if (out.length > 0 && out.at(-1)!.length > 0) out.push([]);
  };
  let fence: { mark: string; length: number } | null = null;
  for (const raw of text.split('\n')) {
    const line = detab(raw).trimEnd();
    const fenced = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (fenced && fenced[1]![0] === fence.mark && fenced[1]!.length >= fence.length && fenced[2]!.trim() === '') {
        fence = null;
        continue;
      }
      // Code is never wrapped: what does not fit is cut, and marked as cut.
      const gutter: Line = max >= 6 ? [{ text: `${g.bar} `, style: { fg: 'faint' } }] : [];
      out.push([...gutter, ...clip([{ text: line, style: CODE }], max - (gutter.length > 0 ? 2 : 0), { text: g.ellipsis, style: DIM })]);
      continue;
    }
    if (fenced && !(fenced[1]![0] === '`' && fenced[2]!.includes('`'))) {
      fence = { mark: fenced[1]![0]!, length: fenced[1]!.length };
      continue;
    }
    if (line.trim() === '') {
      blank();
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push([{ text: g.rule.repeat(Math.max(1, Math.min(max, 48))), style: { fg: 'faint' } }]);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      blank();
      out.push(...wrap(inline(heading[2]!, { bold: true }), max));
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      const bar: Line = [{ text: `${g.bar} `, style: { fg: 'faint' } }];
      out.push(...wrap(inline(quote[1]!, { italic: true }), max, bar));
      continue;
    }
    const item = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))\s+(.*)$/.exec(line);
    if (item) {
      const indent = ' '.repeat(Math.min(width(item[1]!), 8));
      const mark = item[2] !== undefined ? `${g.bullet} ` : `${item[3]}${item[4]} `;
      const first: Line = [{ text: indent }, { text: mark, style: DIM }];
      out.push(...wrap(inline(item[5]!), max, first, [{ text: indent + ' '.repeat(width(mark)) }]));
      continue;
    }
    // Text indented under a list item, or anything else: it keeps its indent on every row.
    const lead = /^ */.exec(line)![0];
    const indent: Line = lead === '' ? [] : [{ text: ' '.repeat(Math.min(lead.length, 8)) }];
    out.push(...wrap(inline(line.slice(lead.length)), max, indent));
  }
  while (out.length > 0 && out.at(-1)!.length === 0) out.pop();
  return out;
}
