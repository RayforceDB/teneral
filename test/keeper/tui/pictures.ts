// The smallest files that are each kind of picture, as far as their first bytes go: enough to be
// told apart and measured. None of them would open in a viewer.

const bytes = (...parts: (string | number[])[]): Buffer => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
const be16 = (n: number): number[] => [n >> 8, n & 0xff];
const be32 = (n: number): number[] => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, n >> 8];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, n >> 16];
const le32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];

/** `pad` more bytes after the header, so that two pictures of one size can differ. */
export function png(width: number, height: number, pad = 0): Buffer {
  return bytes('\x89PNG\r\n\x1a\n', be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0], Array.from({ length: pad }, (_, i) => i % 251));
}

export function gif(width: number, height: number): Buffer {
  return bytes('GIF89a', le16(width), le16(height), [0, 0, 0]);
}

/** An application segment, a table, then the frame: the size is not in the first segment. */
export function jpeg(width: number, height: number): Buffer {
  return bytes([0xff, 0xd8], [0xff, 0xe0], be16(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xdb], be16(4), [0, 0], [0xff, 0xc2], be16(11), [8], be16(height), be16(width), [1, 1, 0x11, 0]);
}

export function webp(kind: 'VP8X' | 'VP8L' | 'VP8 ', width: number, height: number): Buffer {
  const chunk = kind === 'VP8X' ? bytes([0, 0, 0, 0], le24(width - 1), le24(height - 1))
    : kind === 'VP8L' ? bytes([0x2f], le32(((width - 1) | ((height - 1) << 14)) >>> 0))
      : bytes([0, 0, 0], [0x9d, 0x01, 0x2a], le16(width), le16(height));
  return bytes('RIFF', le32(4 + 8 + chunk.length), 'WEBP', kind, le32(chunk.length), [...chunk]);
}
