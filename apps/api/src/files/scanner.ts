import { connect } from 'node:net';

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
 * network. Any failure to get a clear answer is an error, never "clean".
 */
export function clamdScanner(host: string, port: number, timeoutMs = 120_000): Scanner {
  return {
    scan(chunks) {
      return new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host, port });
        let answer = '';
        const fail = (error: Error): void => {
          socket.destroy();
          reject(error);
        };
        socket.setTimeout(timeoutMs, () => {
          fail(new Error('antivirus did not answer in time'));
        });
        socket.on('error', fail);
        socket.on('data', (data: Buffer) => {
          answer += data.toString('utf8');
        });
        socket.on('end', () => {
          const reply = answer.replace(/\0/g, '').trim();
          if (/^stream: OK$/.test(reply)) resolve('clean');
          else if (/^stream: .+ FOUND$/.test(reply)) resolve('infected');
          else reject(new Error('unexpected answer from the antivirus'));
        });
        socket.on('connect', () => {
          void (async () => {
            socket.write('zINSTREAM\0');
            for await (const chunk of chunks) {
              for (let at = 0; at < chunk.length; at += 1024 * 1024) {
                const piece = chunk.subarray(at, at + 1024 * 1024);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(piece.length);
                socket.write(length);
                socket.write(piece);
              }
            }
            socket.end(Buffer.alloc(4));
          })().catch((error: unknown) => {
            fail(error instanceof Error ? error : new Error('could not send the file'));
          });
        });
      });
    },
  };
}
