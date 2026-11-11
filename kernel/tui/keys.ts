// What the terminal sends when the owner presses or pastes, read from the bytes as they
// arrive. An escape sequence may come in two reads; a lone ESC may be the Escape key or the start
// of a sequence, and only time tells: the caller calls `flush` when nothing followed.

export type KeyName =
  | 'enter' | 'tab' | 'backspace' | 'delete' | 'escape'
  | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown';

export type Key =
  /** Printable characters, as typed. */
  | { kind: 'text'; text: string }
  /** A bracketed paste, whole. Line breaks are `\n`. */
  | { kind: 'paste'; text: string }
  /** A named key, or a letter held with Ctrl or Alt (`name` is then that letter). */
  | { kind: 'key'; name: KeyName | string; ctrl?: boolean; alt?: boolean; shift?: boolean }
  /** No key: the terminal's answer to a status request. It is still there. */
  | { kind: 'alive' };

const PASTE_END = '\x1b[201~';
/** The longest paste taken; the rest of a longer one is dropped. */
const PASTE_LIMIT = 200_000;

const FINALS: Record<string, KeyName> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDES: Record<string, KeyName> = { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pageup', 6: 'pagedown' };
const CODES: Record<string, KeyName> = { 13: 'enter', 9: 'tab', 27: 'escape', 127: 'backspace' };

function named(name: KeyName, modifier: string | undefined): Key {
  const bits = Math.max(0, (Number(modifier) || 1) - 1);
  const key: Key = { kind: 'key', name };
  if (bits & 1) key.shift = true;
  if (bits & 2) key.alt = true;
  if (bits & 4) key.ctrl = true;
  return key;
}

export class KeyParser {
  private buf = '';
  private paste: string | null = null;

  /** Whether something is held back until more arrives or `flush` is called. */
  get pending(): boolean {
    return this.buf !== '' && this.paste === null;
  }

  feed(chunk: string): Key[] {
    this.buf += chunk;
    const keys: Key[] = [];
    while (this.buf !== '') {
      if (this.paste !== null) {
        if (!this.pasting(keys)) break;
        continue;
      }
      const c = this.buf[0]!;
      if (c === '\x1b') {
        if (!this.escape(keys)) break;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) {
        const run = /^[^\x00-\x1f\x7f-\x9f]+/.exec(this.buf)![0];
        keys.push({ kind: 'text', text: run });
        this.buf = this.buf.slice(run.length);
        continue;
      }
      this.buf = this.buf.slice(1);
      if (c === '\r') keys.push({ kind: 'key', name: 'enter' });
      else if (c === '\t') keys.push({ kind: 'key', name: 'tab' });
      else if (c === '\x7f' || c === '\b') keys.push({ kind: 'key', name: 'backspace' });
      else if (code >= 1 && code <= 26) keys.push({ kind: 'key', name: String.fromCharCode(code + 96), ctrl: true });
      // Anything else below a space, and the 8-bit controls, mean nothing here.
    }
    return keys;
  }

  /** Nothing followed in time: a lone ESC was the Escape key, and half a sequence was noise. */
  flush(): Key[] {
    if (this.paste !== null) return [];
    const held = this.buf;
    this.buf = '';
    return held === '\x1b' ? [{ kind: 'key', name: 'escape' }] : [];
  }

  /** Inside a paste. Returns false when the end of it has not arrived yet. */
  private pasting(keys: Key[]): boolean {
    const end = this.buf.indexOf(PASTE_END);
    const take = (text: string) => { if (this.paste!.length < PASTE_LIMIT) this.paste += text.slice(0, PASTE_LIMIT - this.paste!.length); };
    if (end === -1) {
      // Keep back what could be the start of the end marker.
      let keep = 0;
      for (let n = Math.min(PASTE_END.length - 1, this.buf.length); n > 0; n--) {
        if (PASTE_END.startsWith(this.buf.slice(-n))) { keep = n; break; }
      }
      take(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return false;
    }
    take(this.buf.slice(0, end));
    keys.push({ kind: 'paste', text: this.paste!.replace(/\r\n?/g, '\n') });
    this.paste = null;
    this.buf = this.buf.slice(end + PASTE_END.length);
    return true;
  }

  /** At an ESC. Returns false when the sequence is not whole yet. */
  private escape(keys: Key[]): boolean {
    const b = this.buf;
    if (b.length === 1) return false;
    const next = b[1]!;
    if (next === '[') {
      // An old-style mouse report, from a terminal left in that mode by something else: three bytes follow the M. Nothing here asks for the mouse.
      if (b[2] === 'M') {
        if (b.length < 6) return false;
        this.buf = b.slice(6);
        return true;
      }
      const m = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(b);
      if (!m) {
        if (/^\x1b\[[0-?]*[ -/]*$/.test(b)) return false;
        this.buf = b.slice(2);
        return true;
      }
      this.buf = b.slice(m[0].length);
      this.csi(m[1]!, m[3]!, keys);
      return true;
    }
    if (next === 'O') {
      if (b.length < 3) return false;
      this.buf = b.slice(3);
      const name = FINALS[b[2]!];
      if (name) keys.push({ kind: 'key', name });
      else if (b[2] === 'M') keys.push({ kind: 'key', name: 'enter' });
      return true;
    }
    if (next === '\x1b') {
      this.buf = b.slice(1);
      keys.push({ kind: 'key', name: 'escape' });
      return true;
    }
    // Alt held with a key: the key comes after an ESC.
    const ch = String.fromCodePoint(b.codePointAt(1)!);
    this.buf = b.slice(1 + ch.length);
    if (ch === '\r' || ch === '\n') keys.push({ kind: 'key', name: 'enter', alt: true });
    else if (ch === '\x7f' || ch === '\b') keys.push({ kind: 'key', name: 'backspace', alt: true });
    else if (ch >= ' ') keys.push({ kind: 'key', name: ch, alt: true });
    return true;
  }

  private csi(params: string, final: string, keys: Key[]): void {
    // A mouse report: the mouse is the terminal's own, and nothing is made of it.
    if (params.startsWith('<')) return;
    const p = params.split(';');
    if (final === '~') {
      if (p[0] === '200') this.paste = '';
      // A key the terminal reports by its code, with what was held: Shift+Enter, where it is told apart at all.
      else if (p[0] === '27' && CODES[p[2] ?? '']) keys.push(named(CODES[p[2]!]!, p[1]));
      else if (TILDES[p[0]!]) keys.push(named(TILDES[p[0]!]!, p[1]));
      return;
    }
    if (final === 'u') {
      if (CODES[p[0]!]) keys.push(named(CODES[p[0]!]!, p[1]));
      return;
    }
    if (final === 'n') {
      if (params === '0') keys.push({ kind: 'alive' });
      return;
    }
    if (final === 'Z') keys.push({ kind: 'key', name: 'tab', shift: true });
    else if (FINALS[final]) keys.push(named(FINALS[final]!, p[1]));
  }
}
