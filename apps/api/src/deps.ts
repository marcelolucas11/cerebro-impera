import type { Updater } from './updates/client.js';
import type { Config } from './config.js';
import type { PasswordHasher } from './crypto/password.js';
import type { Vault } from './crypto/vault.js';
import type { Pools } from './db.js';
import type { Scanner } from './files/scanner.js';
import type { FileStore } from './files/store.js';

/** Everything a request handler needs, passed explicitly so tests can swap parts. */
export interface Deps {
  config: Config;
  pools: Pools;
  vault: Vault;
  hasher: PasswordHasher;
  /** Current time in milliseconds. Injected so second-factor tests can move the clock. */
  now: () => number;
  /** Attachment content on disk. */
  files: FileStore;
  /** The antivirus, or null while the installation has not chosen one. */
  scanner: Scanner | null;
  /** The updater, or null when this installation has none. */
  updater: Updater | null;
}
