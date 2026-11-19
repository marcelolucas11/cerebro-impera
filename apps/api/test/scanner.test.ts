import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clamdScanner } from '../src/files/scanner.js';

/*
 * The talk with ClamAV's daemon, against a stand-in that speaks its INSTREAM
 * protocol: the file goes in pieces of at most 1 MiB, the answer decides, and a
 * file past the daemon's limit is marked as not checked instead of waiting forever.
 */

interface Received {
  command: string;
  content: Buffer;
  pieces: number[];
}

type Behaviour = (received: Received, socket: Socket) => 'continue' | 'done';

let server: Server | undefined;
const open = new Set<Socket>();

/** Stops the stand-in, hanging up on anyone still connected. */
async function stop(): Promise<void> {
  for (const socket of open) socket.destroy();
  open.clear();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = undefined;
}

/** A daemon that reads the stream and, at the end (or earlier), does what it is told. */
async function fakeClamd(
  onPiece: Behaviour,
  answerAtEnd: string | null,
): Promise<{ port: number; seen: Received[] }> {
  const seen: Received[] = [];
  // Like the daemon, it does not hang up just because the sender finished.
  server = createServer({ allowHalfOpen: true }, (socket) => {
    const received: Received = { command: '', content: Buffer.alloc(0), pieces: [] };
    seen.push(received);
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = Buffer.alloc(0);
    let stopped = false;
    socket.on('error', () => undefined);
    socket.on('data', (data: Buffer) => {
      if (stopped) return;
      buffer = Buffer.concat([buffer, data]);
      if (received.command === '') {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        received.command = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          stopped = true;
          if (answerAtEnd === null) socket.end();
          else socket.end(`${answerAtEnd}\0`);
          return;
        }
        if (buffer.length < 4 + length) return;
        received.pieces.push(length);
        received.content = Buffer.concat([received.content, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
        if (onPiece(received, socket) === 'done') {
          stopped = true;
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, seen };
}

const keepGoing: Behaviour = () => 'continue';

/** A file of the given size in chunks, counting how much of it was read. */
function fileOf(size: number, chunk = 700_000) {
  const read = { bytes: 0, closed: false };
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for (let at = 0; at < size; at += chunk) {
        // Like reading from disk: each piece takes a turn.
        await new Promise((resolve) => setImmediate(resolve));
        const piece = Buffer.alloc(Math.min(chunk, size - at), at % 251);
        read.bytes += piece.length;
        yield piece;
      }
    } finally {
      read.closed = true;
    }
  }
  return { chunks: chunks(), read };
}

afterEach(stop);

describe('the ClamAV daemon', () => {
  it('gets the whole file in pieces of at most 1 MiB, and a clean answer means clean', async () => {
    const daemon = await fakeClamd(keepGoing, 'stream: OK');
    const file = fileOf(2_500_000, 1_500_000);
    const result = await clamdScanner('127.0.0.1', daemon.port).scan(file.chunks);
    expect(result).toBe('clean');
    const received = daemon.seen[0];
    expect(received?.command).toBe('zINSTREAM');
    expect(received?.content.length).toBe(2_500_000);
    expect(Math.max(...(received?.pieces ?? []))).toBeLessThanOrEqual(1024 * 1024);
    expect(received?.pieces).toEqual([1024 * 1024, 1_500_000 - 1024 * 1024, 1_000_000]);
  });

  it('blocks what it finds', async () => {
    const daemon = await fakeClamd(keepGoing, 'stream: Eicar-Test-Signature FOUND');
    const result = await clamdScanner('127.0.0.1', daemon.port).scan(fileOf(10).chunks);
    expect(result).toBe('infected');
  });

  it('marks a file past its limit as not checked, and stops reading it', async () => {
    const limit = 3 * 1024 * 1024;
    const daemon = await fakeClamd((received, socket) => {
      if (received.content.length < limit) return 'continue';
      socket.end('INSTREAM size limit exceeded. ERROR\0');
      return 'done';
    }, null);
    const file = fileOf(64 * 1024 * 1024);
    const result = await clamdScanner('127.0.0.1', daemon.port).scan(file.chunks);
    expect(result).toBe('not_scanned');
    expect(file.read.bytes).toBeLessThan(64 * 1024 * 1024);
    // The file is closed, not left half read.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(file.read.closed).toBe(true);
  });

  it('says the same when the daemon hangs up hard right after saying so', async () => {
    const daemon = await fakeClamd((received, socket) => {
      if (received.content.length < 2 * 1024 * 1024) return 'continue';
      socket.write('INSTREAM size limit exceeded. ERROR\0');
      setTimeout(() => socket.resetAndDestroy(), 100);
      return 'done';
    }, null);
    const file = fileOf(256 * 1024 * 1024);
    const result = await clamdScanner('127.0.0.1', daemon.port).scan(file.chunks);
    expect(result).toBe('not_scanned');
  });

  it('reads the file no faster than the daemon takes it', async () => {
    const daemon = await fakeClamd((_received, socket) => {
      socket.pause();
      return 'done';
    }, null);
    const file = fileOf(256 * 1024 * 1024);
    const scanning = clamdScanner('127.0.0.1', daemon.port, 600).scan(file.chunks);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // What the network holds, not the whole file in memory.
    expect(file.read.bytes).toBeLessThan(32 * 1024 * 1024);
    await expect(scanning).rejects.toThrow('antivirus did not answer in time');
  });

  it('never takes any other answer, or none, as clean', async () => {
    for (const answer of ['stream: OK OK', 'stream: ERROR', 'OK', 'FOUND', '']) {
      const daemon = await fakeClamd(keepGoing, answer);
      await expect(
        clamdScanner('127.0.0.1', daemon.port).scan(fileOf(10).chunks),
        answer,
      ).rejects.toThrow('unexpected answer from the antivirus');
      await stop();
    }
    const silent = await fakeClamd(keepGoing, null);
    await expect(clamdScanner('127.0.0.1', silent.port).scan(fileOf(10).chunks)).rejects.toThrow(
      'unexpected answer from the antivirus',
    );
  });

  it('gives up when the daemon does not answer in time, or is not there', async () => {
    const stuck = await fakeClamd(() => 'done', null);
    await expect(
      clamdScanner('127.0.0.1', stuck.port, 200).scan(fileOf(10).chunks),
    ).rejects.toThrow('antivirus did not answer in time');
    const port = stuck.port;
    await stop();
    await expect(clamdScanner('127.0.0.1', port, 200).scan(fileOf(10).chunks)).rejects.toThrow();
  });
});
