import { crc32, inflateSync } from 'node:zlib';

/*
 * The logo's PNG files, read byte by byte before anything keeps them.
 *
 * The browser draws them on a canvas, so a genuine one is plain: a header, the
 * pixels, an end. Anything else is either refused (an unknown part a viewer
 * would have to understand, a size that is not the one asked for, pixels that
 * do not add up) or left out (ancillary parts such as text or a camera's
 * metadata). What is kept is rebuilt from the parts that passed, so a byte the
 * check did not understand never reaches anyone.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parts kept as they are. Every other part is ancillary (dropped) or refused. */
const KEPT = new Set(['IHDR', 'tRNS', 'IDAT', 'IEND']);

/** Bytes per pixel for the color types a canvas writes: RGB and RGB with transparency. */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };

export type PngProblem =
  | 'not_png'
  | 'damaged'
  | 'unexpected_part'
  | 'wrong_size'
  | 'unsupported_format'
  | 'pixels_do_not_add_up';

export type PngResult = { ok: true; png: Buffer } | { ok: false; problem: PngProblem };

interface Part {
  type: string;
  data: Buffer;
  raw: Buffer;
}

function parts(bytes: Buffer): Part[] | PngProblem {
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, 8).equals(SIGNATURE)) return 'not_png';
  const found: Part[] = [];
  let at = SIGNATURE.length;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) return 'damaged';
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (length > 0x7fff_ffff || end > bytes.length) return 'damaged';
    const typeBytes = bytes.subarray(at + 4, at + 8);
    // A part's name is four ASCII letters.
    if (!typeBytes.every((c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 'damaged';
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length))
      return 'damaged';
    found.push({ type: typeBytes.toString('latin1'), data, raw: bytes.subarray(at, end) });
    at = end;
    // Nothing may follow the end.
    if (found.at(-1)?.type === 'IEND') return at === bytes.length ? found : 'damaged';
  }
  return 'damaged';
}

/** Checks one PNG that must be exactly `size` by `size` pixels, and rebuilds it. */
export function checkPng(bytes: Buffer, size: number): PngResult {
  const found = parts(bytes);
  if (typeof found === 'string') return { ok: false, problem: found };

  const header = found[0];
  if (header?.type !== 'IHDR' || header.data.length !== 13)
    return { ok: false, problem: 'unexpected_part' };
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [depth, colorType, compression, filter, interlace] = header.data.subarray(8);
  if (width !== size || height !== size) return { ok: false, problem: 'wrong_size' };
  const channels = colorType === undefined ? undefined : CHANNELS[colorType];
  if (depth !== 8 || channels === undefined || compression !== 0 || filter !== 0 || interlace !== 0)
    return { ok: false, problem: 'unsupported_format' };

  const kept: Part[] = [];
  let seenData = false;
  let dataEnded = false;
  for (const part of found) {
    // The pixels come in one unbroken run of parts.
    if (part.type === 'IDAT') {
      if (dataEnded) return { ok: false, problem: 'unexpected_part' };
      seenData = true;
    } else if (seenData) {
      dataEnded = true;
    }
    const ancillary = (part.type.charCodeAt(0) & 0x20) !== 0;
    if (!KEPT.has(part.type)) {
      // A critical part this check does not know cannot be skipped safely.
      if (!ancillary) return { ok: false, problem: 'unexpected_part' };
      continue;
    }
    if (part.type === 'IHDR' && part !== header) return { ok: false, problem: 'unexpected_part' };
    if (part.type === 'tRNS' && (seenData || colorType !== 2 || part.data.length !== 6))
      return { ok: false, problem: 'unexpected_part' };
    if (part.type === 'IEND' && part.data.length !== 0) return { ok: false, problem: 'damaged' };
    kept.push(part);
  }
  if (!seenData) return { ok: false, problem: 'pixels_do_not_add_up' };

  // The pixels must unpack to exactly the size the header promises, with no
  // room to unpack into more than that.
  const rowBytes = 1 + width * channels;
  const expected = rowBytes * height;
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(kept.filter((p) => p.type === 'IDAT').map((p) => p.data)), {
      maxOutputLength: expected,
    });
  } catch {
    return { ok: false, problem: 'pixels_do_not_add_up' };
  }
  if (pixels.length !== expected) return { ok: false, problem: 'pixels_do_not_add_up' };
  for (let row = 0; row < height; row += 1) {
    const filterType = pixels[row * rowBytes] ?? 255;
    if (filterType > 4) return { ok: false, problem: 'pixels_do_not_add_up' };
  }

  return { ok: true, png: Buffer.concat([SIGNATURE, ...kept.map((part) => part.raw)]) };
}
