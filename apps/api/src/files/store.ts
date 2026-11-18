import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Attachment content on disk: one folder per attachment, one file per part,
 * each part sealed on its own with the attachment's key. A part sealed for one
 * place (attachment, position) does not open anywhere else, so parts cannot be
 * swapped, reordered or moved between files without it showing.
 */

/** Size of every part but the last. Also the size of each upload request. */
export const PART_SIZE = 8 * 1024 * 1024;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const partCount = (size: number): number => Math.ceil(size / PART_SIZE);

export function partLength(size: number, n: number): number {
  const count = partCount(size);
  if (!Number.isInteger(n) || n < 0 || n >= count) return 0;
  return n === count - 1 ? size - PART_SIZE * (count - 1) : PART_SIZE;
}

const placeOf = (attachmentId: string, n: number): Buffer =>
  Buffer.from(`cerebro-attachment-part:${attachmentId}:${n}`, 'utf8');

export function sealPart(key: Buffer, attachmentId: string, n: number, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(placeOf(attachmentId, n));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

/** Throws when the part was altered, moved, or belongs to another file. */
export function openPart(key: Buffer, attachmentId: string, n: number, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('damaged part');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
  decipher.setAAD(placeOf(attachmentId, n));
  decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
}

export class FileStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #folder(attachmentId: string): string {
    // Ids come from the database, but a path is only ever built from a well-formed one.
    if (!ID_PATTERN.test(attachmentId)) throw new Error('invalid attachment id');
    return join(this.#root, attachmentId);
  }

  async writePart(attachmentId: string, n: number, sealed: Buffer): Promise<void> {
    const folder = this.#folder(attachmentId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const final = join(folder, String(n));
    const temporary = join(folder, `${n}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Whole parts only: a reader never sees half of one.
    await rename(temporary, final);
  }

  readPart(attachmentId: string, n: number): Promise<Buffer> {
    return readFile(join(this.#folder(attachmentId), String(n)));
  }

  async remove(attachmentId: string): Promise<void> {
    await rm(this.#folder(attachmentId), { recursive: true, force: true });
  }

  /** Space left on the volume, for refusing an upload that would fill it. */
  async freeBytes(): Promise<number> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const stats = await statfs(this.#root);
    return stats.bavail * stats.bsize;
  }
}
