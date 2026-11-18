import { describe, expect, it } from 'vitest';
import { ApiError, type Attachment } from '../src/api.js';
import {
  ATTEMPTS_PER_PART,
  beginUpload,
  continueUpload,
  sameFile,
  type LocalFile,
  type UploadIo,
} from '../src/upload.js';

const PART = 4;

function fileOf(text: string, name = 'notas.txt'): LocalFile {
  const blob = new Blob([text]);
  return {
    name,
    size: blob.size,
    type: 'text/plain',
    slice: (start, end) => blob.slice(start, end),
  };
}

/** A pretend server: keeps what it receives and can fail a part a few times. */
function fakeServer(options: { have?: number[]; failures?: Record<number, ApiError[]> } = {}) {
  const received = new Map<number, string>();
  for (const n of options.have ?? []) received.set(n, '(já estava)');
  const failures = options.failures ?? {};
  const waits: number[] = [];
  let size = 0;
  const io: UploadIo = {
    start: (_itemId, input) => {
      size = input.size;
      return Promise.resolve({ id: 'u1', partSize: PART, parts: Math.ceil(input.size / PART) });
    },
    state: () =>
      Promise.resolve({
        partSize: PART,
        parts: Math.ceil(size / PART),
        received: [...received.keys()].sort((a, b) => a - b),
      }),
    sendPart: async (_id, n, part) => {
      const next = failures[n]?.shift();
      if (next) throw next;
      received.set(n, await part.text());
      return {};
    },
    finish: () => Promise.resolve({ id: 'u1', status: 'scanning' } as Attachment),
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  };
  return {
    io,
    received,
    waits,
    setSize: (bytes: number) => {
      size = bytes;
    },
  };
}

describe('sending a file', () => {
  it('goes out part by part, in order, and is closed at the end', async () => {
    const server = fakeServer();
    const file = fileOf('abcdefghij');
    const id = await beginUpload(server.io, 'item', file);
    const progress: number[] = [];
    const done = await continueUpload(server.io, id, file, (sent) => progress.push(sent));
    expect([...server.received.entries()]).toEqual([
      [0, 'abcd'],
      [1, 'efgh'],
      [2, 'ij'],
    ]);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(done.status).toBe('scanning');
  });

  it('continues where it stopped: what the server already has is not sent again', async () => {
    const server = fakeServer({ have: [0, 2] });
    const file = fileOf('abcdefghij');
    server.setSize(file.size);
    const progress: number[] = [];
    await continueUpload(server.io, 'u1', file, (sent) => progress.push(sent));
    expect(server.received.get(0)).toBe('(já estava)');
    expect(server.received.get(1)).toBe('efgh');
    expect(server.received.get(2)).toBe('(já estava)');
    expect(progress).toEqual([6, 10]);
  });

  it('tries a part again when the connection drops, waiting longer each time', async () => {
    const lost = new ApiError(0, 'network');
    const server = fakeServer({ failures: { 1: [lost, new ApiError(502, 'unknown')] } });
    const file = fileOf('abcdefgh');
    const id = await beginUpload(server.io, 'item', file);
    await continueUpload(server.io, id, file, () => undefined);
    expect(server.received.get(1)).toBe('efgh');
    expect(server.waits).toEqual([1000, 2000]);
  });

  it('gives up after a few attempts, leaving the rest for when the person tries again', async () => {
    const failures = Array.from({ length: ATTEMPTS_PER_PART }, () => new ApiError(0, 'network'));
    const server = fakeServer({ failures: { 0: failures } });
    const file = fileOf('abcdefgh');
    const id = await beginUpload(server.io, 'item', file);
    await expect(continueUpload(server.io, id, file, () => undefined)).rejects.toMatchObject({
      code: 'network',
    });
    expect(server.received.size).toBe(0);
    // Trying again later picks up from the same place.
    await continueUpload(server.io, id, file, () => undefined);
    expect(server.received.size).toBe(2);
  });

  it('does not insist when the server refuses: that will not change by trying again', async () => {
    const server = fakeServer({ failures: { 0: [new ApiError(400, 'invalid_part_size')] } });
    const file = fileOf('abcdefgh');
    const id = await beginUpload(server.io, 'item', file);
    await expect(continueUpload(server.io, id, file, () => undefined)).rejects.toMatchObject({
      code: 'invalid_part_size',
    });
    expect(server.waits).toEqual([]);
  });

  it('stops when the person cancels', async () => {
    const server = fakeServer();
    const file = fileOf('abcdefgh');
    const id = await beginUpload(server.io, 'item', file);
    const stop = new AbortController();
    stop.abort();
    await expect(
      continueUpload(server.io, id, file, () => undefined, stop.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.received.size).toBe(0);
  });

  it('sends a name the server accepts, whatever the file was called', async () => {
    const names: string[] = [];
    const io: UploadIo = {
      ...fakeServer().io,
      start: (_itemId, input) => {
        names.push(input.name);
        return Promise.resolve({ id: 'u1', partSize: PART, parts: 1 });
      },
    };
    await beginUpload(io, 'item', fileOf('x', 'a/b\u0000.txt'));
    expect(names).toEqual(['a_b_.txt']);
  });
});

describe('continuing after a reload', () => {
  it('accepts the same file again, and nothing that is plainly another one', () => {
    const waiting = { name: 'a_b.txt', size: 8 };
    expect(sameFile(waiting, fileOf('abcdefgh', 'a/b.txt'))).toBe(true);
    expect(sameFile(waiting, fileOf('abcdefg', 'a/b.txt'))).toBe(false);
    expect(sameFile(waiting, fileOf('abcdefgh', 'outro.txt'))).toBe(false);
  });
});
