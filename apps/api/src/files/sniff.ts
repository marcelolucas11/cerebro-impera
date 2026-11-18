/*
 * What a file really is, read from its first bytes rather than from its name
 * or what the browser claimed. Only these types are ever shown inside the
 * page; everything else is always downloaded.
 */

export { PREVIEWABLE_TYPES as PREVIEWABLE } from '@cerebro/shared';

const starts = (head: Buffer, bytes: number[], at = 0): boolean =>
  head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte);
const ascii = (head: Buffer, text: string, at = 0): boolean =>
  starts(head, [...Buffer.from(text, 'latin1')], at);

/** The type the content shows, or null when it is none of the known ones. */
export function detectType(head: Buffer): string | null {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 'GIF87a') || ascii(head, 'GIF89a')) return 'image/gif';
  if (ascii(head, 'RIFF') && ascii(head, 'WEBP', 8)) return 'image/webp';
  if (ascii(head, 'RIFF') && ascii(head, 'WAVE', 8)) return 'audio/wav';
  if (ascii(head, '%PDF-')) return 'application/pdf';
  if (ascii(head, 'ID3') || starts(head, [0xff, 0xfb]) || starts(head, [0xff, 0xf3])) {
    return 'audio/mpeg';
  }
  if (ascii(head, 'OggS')) return 'audio/ogg';
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(head, 'ftyp', 4)) {
    return ascii(head, 'M4A ', 8) ? 'audio/mp4' : 'video/mp4';
  }
  return null;
}
