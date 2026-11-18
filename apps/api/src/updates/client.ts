import { randomBytes } from 'node:crypto';
import { sign, UpdaterRefusal, type UpdaterStatus } from '@cerebro/shared/protocol';

/** The updater, as the API sees it. */
export interface Updater {
  status(): Promise<UpdaterStatus>;
  check(): Promise<UpdaterStatus>;
  apply(version: string): Promise<UpdaterStatus>;
}

/** The updater out of reach (stopped, restarting, network down). */
export class UpdaterUnreachable extends Error {}

const TIMEOUT_MS = 30_000;

/** Talks to the updater over the internal network, every request signed. */
export function httpUpdater(baseUrl: string, key: Buffer, now: () => number = Date.now): Updater {
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<UpdaterStatus> => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = sign(key, {
      method,
      path,
      body,
      time: now(),
      nonce: randomBytes(18).toString('base64url'),
    });
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        headers: { ...headers, ...(body === '' ? {} : { 'content-type': 'application/json' }) },
        ...(body === '' ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new UpdaterUnreachable();
    }
    const data = (await response.json().catch(() => null)) as
      (UpdaterStatus & { error?: { code?: unknown } }) | null;
    if (!response.ok) {
      const code = data?.error?.code;
      throw new UpdaterRefusal(typeof code === 'string' ? code : 'updater_error');
    }
    if (data === null) throw new UpdaterUnreachable();
    return data;
  };
  return {
    status: () => call('GET', '/status'),
    check: () => call('POST', '/check'),
    apply: (version) => call('POST', '/apply', { version }),
  };
}
