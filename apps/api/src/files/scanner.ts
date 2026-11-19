import { connect, type Socket } from 'node:net';

/*
 * The antivirus. It reads a file as a stream of chunks and says whether it is
 * clean. Which one runs is a setting of the installation; see
 * docs/design/anexos.md, section 6.
 */

export type ScanResult = 'clean' | 'infected' | 'not_scanned';

export interface Scanner {
  scan(chunks: AsyncIterable<Buffer>): Promise<ScanResult>;
}

/** The installation chose to run without an antivirus: files are marked as not checked. */
export const noScanner: Scanner = {
  async scan(chunks) {
    // Still read to the end: every part is opened, so damaged content is noticed.
    const parts = chunks[Symbol.asyncIterator]();
    while ((await parts.next()).done !== true) continue;
    return 'not_scanned';
  },
};

/**
 * ClamAV's daemon, over its INSTREAM command on the installation's internal
 * network. Any failure to get a clear answer is an error, never "clean". A file
 * larger than the daemon accepts (its StreamMaxLength) can never get an answer:
 * it is marked as not checked, like with no antivirus, instead of waiting forever.
 */
export function clamdScanner(host: string, port: number, timeoutMs = 120_000): Scanner {
  return {
    scan(chunks) {
      return new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host, port });
        let answer = '';
        let settled = false;
        const settle = (outcome: ScanResult | Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
        const tooLarge = (): boolean => /size limit exceeded/i.test(answer);
        socket.setTimeout(timeoutMs, () => {
          settle(new Error('antivirus did not answer in time'));
        });
        // Past its limit the daemon answers and hangs up while the file is still going.
        socket.on('error', (error: Error) => {
          settle(tooLarge() ? 'not_scanned' : error);
        });
        socket.on('data', (data: Buffer) => {
          answer += data.toString('utf8');
        });
        socket.on('end', () => {
          const reply = answer.replace(/\0/g, '').trim();
          if (/^stream: OK$/.test(reply)) settle('clean');
          else if (/^stream: .+ FOUND$/.test(reply)) settle('infected');
          else if (tooLarge()) settle('not_scanned');
          else settle(new Error('unexpected answer from the antivirus'));
        });
        socket.on('connect', () => {
          void (async () => {
            socket.write('zINSTREAM\0');
            for await (const chunk of chunks) {
              for (let at = 0; at < chunk.length; at += 1024 * 1024) {
                // Answered already: stop reading the file.
                if (settled) return;
                const piece = chunk.subarray(at, at + 1024 * 1024);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(piece.length);
                socket.write(length);
                // Never more than one piece waiting in memory.
                if (!socket.write(piece)) await drained(socket);
              }
            }
            if (!settled) socket.end(Buffer.alloc(4));
          })().catch((error: unknown) => {
            settle(error instanceof Error ? error : new Error('could not send the file'));
          });
        });
      });
    },
  };
}

function drained(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      socket.off('drain', done);
      socket.off('close', done);
      resolve();
    };
    socket.on('drain', done);
    socket.on('close', done);
  });
}
