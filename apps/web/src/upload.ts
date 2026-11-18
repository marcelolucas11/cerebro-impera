import { safeFileName } from '@cerebro/shared';
import { ApiError, type Attachment, type UploadState } from './api.js';

/*
 * Sending a file in parts. Kept apart from the screen so it can be tested
 * without a browser: what goes out, what is skipped because the server
 * already has it, and when to give up.
 */

export interface UploadIo {
  start: (
    itemId: string,
    input: { name: string; size: number; type: string },
  ) => Promise<{ id: string; partSize: number; parts: number }>;
  state: (uploadId: string) => Promise<UploadState>;
  sendPart: (uploadId: string, n: number, part: Blob) => Promise<unknown>;
  finish: (uploadId: string) => Promise<Attachment>;
  /** Pause between attempts; injected so tests do not wait. */
  wait: (milliseconds: number) => Promise<void>;
}

/** A file as the browser gives it: content, name and size. */
export interface LocalFile {
  name: string;
  size: number;
  type: string;
  slice: (start: number, end: number) => Blob;
}

/** How many times a part is tried before the upload stops and waits for the person. */
export const ATTEMPTS_PER_PART = 4;

/** A failure worth trying again by itself: no connection, or the server briefly unwell. */
export function isPassing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

/** Opens an upload for a file on an item. The server checks access, size and free space here. */
export async function beginUpload(io: UploadIo, itemId: string, file: LocalFile): Promise<string> {
  const started = await io.start(itemId, {
    name: safeFileName(file.name),
    size: file.size,
    type: file.type.slice(0, 200),
  });
  return started.id;
}

/**
 * Sends whatever the server does not have yet, then closes the upload. Works
 * the same for a new upload and for one that stopped halfway, even after a
 * reload, as long as it is the same file.
 */
export async function continueUpload(
  io: UploadIo,
  uploadId: string,
  file: LocalFile,
  onProgress: (sentBytes: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  const state = await io.state(uploadId);
  const have = new Set(state.received);
  const length = (n: number): number =>
    Math.min(file.size, (n + 1) * state.partSize) - n * state.partSize;
  let sent = 0;
  for (const n of have) sent += length(n);
  onProgress(sent);

  for (let n = 0; n < state.parts; n += 1) {
    if (have.has(n)) continue;
    const part = file.slice(n * state.partSize, n * state.partSize + length(n));
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted === true) throw new DOMException('stopped', 'AbortError');
      try {
        await io.sendPart(uploadId, n, part);
        break;
      } catch (error) {
        if (!isPassing(error) || attempt >= ATTEMPTS_PER_PART) throw error;
        await io.wait(1000 * 2 ** (attempt - 1));
      }
    }
    sent += length(n);
    onProgress(sent);
  }
  return io.finish(uploadId);
}

/** Whether a file chosen to continue an interrupted upload is plausibly the same one. */
export function sameFile(attachment: Pick<Attachment, 'name' | 'size'>, file: LocalFile): boolean {
  return attachment.size === file.size && attachment.name === safeFileName(file.name);
}
