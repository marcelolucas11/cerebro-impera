/*
 * Trusted Types: the page's security policy refuses to turn text into script
 * anywhere (no HTML from strings, no script address from a string), except
 * through the one policy below, named in that same policy. It accepts a single
 * address, the offline worker's, and nothing else.
 */

interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): { createScriptURL(input: string): unknown };
}

export const WORKER_ADDRESS = '/sw.js';

let policy: { createScriptURL(input: string): unknown } | null | undefined;

/** The worker's address, as the browser accepts it when Trusted Types are required. */
export function workerAddress(): string {
  if (policy === undefined) {
    const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
    policy =
      factory?.createPolicy('cerebro', {
        createScriptURL: (input) => {
          if (input !== WORKER_ADDRESS) throw new TypeError('script address not allowed');
          return input;
        },
      }) ?? null;
  }
  // A TrustedScriptURL where the browser has them; the plain address where it does not.
  return (policy?.createScriptURL(WORKER_ADDRESS) ?? WORKER_ADDRESS) as string;
}
