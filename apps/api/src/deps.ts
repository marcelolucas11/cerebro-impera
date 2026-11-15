import type { Config } from './config.js';
import type { PasswordHasher } from './crypto/password.js';
import type { Vault } from './crypto/vault.js';
import type { Pools } from './db.js';

/** Everything a request handler needs, passed explicitly so tests can swap parts. */
export interface Deps {
  config: Config;
  pools: Pools;
  vault: Vault;
  hasher: PasswordHasher;
  /** Current time in milliseconds. Injected so second-factor tests can move the clock. */
  now: () => number;
}
