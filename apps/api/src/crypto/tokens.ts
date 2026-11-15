import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits from the OS random source, URL-safe. Used for every bearer secret. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Digest sent to the database in place of the raw token. The database hashes
 * it once more before storing or comparing, so neither logs nor a leaked
 * database dump contain anything that can be replayed.
 */
export function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes

/** Ten one-time codes, about 49 bits each, shown to the person exactly once. */
export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    while (code.length < 10) {
      // Rejection sampling keeps the distribution uniform.
      const byte = randomBytes(1)[0] ?? 0;
      if (byte < RECOVERY_ALPHABET.length * 8) {
        code += RECOVERY_ALPHABET.charAt(byte % RECOVERY_ALPHABET.length);
      }
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}
