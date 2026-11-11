const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Text that arrives in pieces and may be endless. Keeps the beginning and the end, half the limit
 * each, and only counts what falls between: the end is where a command usually says what went wrong.
 * A cut never falls inside a surrogate pair, so what comes out is as well formed as what went in.
 */
export class Clipped {
  private readonly half: number;
  private head = '';
  private tail = '';
  private total = 0;

  constructor(limit: number) {
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  add(piece: string): void {
    this.total += piece.length;
    let room = this.half - this.head.length;
    if (room > 0 && room < piece.length && isHigh(piece.charCodeAt(room - 1))) room -= 1;
    this.head += piece.slice(0, room);
    const rest = this.tail + piece.slice(room);
    const tail = rest.slice(-this.half);
    this.tail = tail.length < rest.length && isLow(tail.charCodeAt(0)) ? tail.slice(1) : tail;
  }

  text(): string {
    const dropped = this.total - this.head.length - this.tail.length;
    if (dropped === 0) return this.head + this.tail;
    return `${this.head}\n[${dropped} characters dropped here]\n${this.tail}`;
  }
}

/** The beginning and the end of `text`, about `limit` characters in all, with a note between saying how much is gone. */
export function clip(text: string, limit: number): string {
  const clipped = new Clipped(limit);
  clipped.add(text);
  return clipped.text();
}
