import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts small secrets at rest (second-factor seeds, secret fields) with
 * AES-256-GCM from the platform's crypto library.
 *
 * - Each purpose gets its own key, derived from the instance key with HKDF,
 *   so a key used for one kind of data never touches another.
 * - The `context` (for example "totp:<user id>") is authenticated but not
 *   stored: a ciphertext copied onto another row fails to decrypt.
 */
export class Vault {
  readonly #masterKey: Buffer;
  readonly #keys = new Map<string, Buffer>();

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('the instance key must be 32 bytes');
    this.#masterKey = masterKey;
  }

  #key(purpose: string): Buffer {
    let key = this.#keys.get(purpose);
    if (!key) {
      key = Buffer.from(
        hkdfSync('sha256', this.#masterKey, Buffer.alloc(0), `cerebro/v1/${purpose}`, 32),
      );
      this.#keys.set(purpose, key);
    }
    return key;
  }

  seal(purpose: string, context: string, plaintext: Buffer): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key(purpose), nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]);
  }

  /** Throws when the data was tampered with, moved, or sealed with another key. */
  open(purpose: string, context: string, sealed: Buffer): Buffer {
    if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
      throw new Error('unsupported sealed value');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const tag = sealed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.#key(purpose), nonce);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  /**
   * Keyed digest for secrets too short to resist guessing on their own, such
   * as recovery codes. The key never touches the database, so a stolen
   * database dump cannot be used to brute-force the stored values.
   */
  mac(purpose: string, context: string, value: string): Buffer {
    return createHmac('sha256', this.#key(`mac/${purpose}`))
      .update(context, 'utf8')
      .update('\0')
      .update(value, 'utf8')
      .digest();
  }
}
