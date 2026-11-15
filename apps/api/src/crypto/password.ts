import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Argon2Params } from '../config.js';

/*
 * The library exposes its algorithm list as a const enum, which cannot be
 * imported under `verbatimModuleSyntax`. 2 is Argon2id; a test checks that
 * the produced hashes really are argon2id.
 */
const ARGON2ID = 2;

export class PasswordHasher {
  readonly #params: Argon2Params;
  #decoy: Promise<string> | undefined;

  constructor(params: Argon2Params) {
    this.#params = params;
  }

  hash(password: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- see ARGON2ID above
    return hash(password, { algorithm: ARGON2ID, outputLen: 32, ...this.#params });
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same effort as a real check. Used when the account does not
   * exist, so response time does not reveal which e-mails are registered.
   */
  async burn(password: string): Promise<void> {
    this.#decoy ??= this.hash(randomBytes(24).toString('base64'));
    await this.verify(await this.#decoy, password);
  }
}
