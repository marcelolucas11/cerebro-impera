import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePublicOrigin } from '../src/config.js';
import { PasswordHasher } from '../src/crypto/password.js';
import { digest, newRecoveryCodes, newToken, safeEqual } from '../src/crypto/tokens.js';
import { newTotpSecret, totpCodeAt, verifyTotp } from '../src/crypto/totp.js';
import { Vault } from '../src/crypto/vault.js';
import { initSecrets, readAdminPassword, readFormsSecrets, readSecrets } from '../src/secrets.js';

const scratch = mkdtempSync(join(tmpdir(), 'cerebro-crypto-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('password hashing', () => {
  const hasher = new PasswordHasher({ memoryCost: 4096, timeCost: 1, parallelism: 1 });

  it('uses argon2id with a fresh salt every time', async () => {
    const first = await hasher.hash('lagoa-verde-73-tijolo-quente');
    const second = await hasher.hash('lagoa-verde-73-tijolo-quente');
    expect(first.startsWith('$argon2id$')).toBe(true);
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, 'lagoa-verde-73-tijolo-quente')).toBe(true);
    expect(await hasher.verify(first, 'lagoa-verde-73-tijolo-quentE')).toBe(false);
  });

  it('treats a malformed stored hash as a wrong password, not a crash', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
  });
});

describe('the vault', () => {
  const vault = new Vault(randomBytes(32));
  const secret = Buffer.from('JBSWY3DPEHPK3PXP', 'utf8');

  it('round-trips a secret and never produces the same ciphertext twice', () => {
    const a = vault.seal('totp', 'totp:user-1', secret);
    const b = vault.seal('totp', 'totp:user-1', secret);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(secret)).toBe(false);
    expect(vault.open('totp', 'totp:user-1', a).equals(secret)).toBe(true);
  });

  it('refuses a ciphertext moved to another row, purpose or instance', () => {
    const sealed = vault.seal('totp', 'totp:user-1', secret);
    expect(() => vault.open('totp', 'totp:user-2', sealed)).toThrow();
    expect(() => vault.open('secret-field', 'totp:user-1', sealed)).toThrow();
    expect(() => new Vault(randomBytes(32)).open('totp', 'totp:user-1', sealed)).toThrow();
  });

  it('refuses a ciphertext that was altered', () => {
    const sealed = vault.seal('totp', 'totp:user-1', secret);
    for (const position of [0, 5, 20, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[position] = (copy[position] ?? 0) ^ 0x01;
      expect(() => vault.open('totp', 'totp:user-1', copy)).toThrow();
    }
    expect(() => vault.open('totp', 'totp:user-1', sealed.subarray(0, 10))).toThrow();
  });

  it('fingerprints short secrets with the instance key, per person', () => {
    const mac = vault.mac('recovery-code', 'user-1', 'abcde23456');
    expect(mac).toHaveLength(32);
    expect(mac.equals(vault.mac('recovery-code', 'user-1', 'abcde23456'))).toBe(true);
    expect(mac.equals(vault.mac('recovery-code', 'user-2', 'abcde23456'))).toBe(false);
    expect(mac.equals(vault.mac('other', 'user-1', 'abcde23456'))).toBe(false);
    expect(mac.equals(vault.mac('recovery-code', 'user-1', 'abcde23457'))).toBe(false);
    // Another instance (another key) produces something unrelated.
    expect(
      mac.equals(new Vault(randomBytes(32)).mac('recovery-code', 'user-1', 'abcde23456')),
    ).toBe(false);
  });

  it('only accepts a full-size instance key', () => {
    expect(() => new Vault(randomBytes(16))).toThrow();
  });
});

describe('tokens', () => {
  it('are 256 bits of randomness, URL-safe and never repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = newToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    expect(digest(newToken())).toHaveLength(32);
  });

  it('compare without leaking where they differ', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('produce ten distinct recovery codes without look-alike characters', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  });
});

describe('second-factor codes', () => {
  const secret = newTotpSecret();
  const now = Date.UTC(2030, 0, 1, 12, 0, 0);
  const step = Math.floor(now / 30_000);

  it('are accepted once and never again', () => {
    const code = totpCodeAt(secret, now);
    expect(verifyTotp(secret, code, 0, now)).toBe(step);
    expect(verifyTotp(secret, code, step, now)).toBeNull();
    expect(verifyTotp(secret, code, step, now + 10_000)).toBeNull();
  });

  it('tolerate one period of clock drift and nothing more', () => {
    const code = totpCodeAt(secret, now);
    expect(verifyTotp(secret, code, 0, now + 30_000)).toBe(step);
    expect(verifyTotp(secret, code, 0, now - 30_000)).toBe(step);
    expect(verifyTotp(secret, code, 0, now + 90_000)).toBeNull();
    expect(verifyTotp(newTotpSecret(), code, 0, now)).toBeNull();
  });
});

describe('instance secrets', () => {
  it('are generated on the server, readable only by its user, and never overwritten', () => {
    const dir = join(scratch, 'config');
    expect(initSecrets(dir)).toEqual({ created: true, moved: [] });
    const first = readSecrets(dir);
    expect(Buffer.from(first.masterKey, 'base64')).toHaveLength(32);
    const admin = readAdminPassword(dir);
    const passwords = [admin, first.db.appPassword, first.db.authPassword];
    expect(new Set(passwords).size).toBe(3);
    for (const password of passwords) expect(password.length).toBeGreaterThanOrEqual(43);

    for (const file of [
      'api/secrets.json',
      'db/admin-password',
      'updater/updater-key',
      'backup/backup-password',
      'forms/db-password',
      'forms/form-key',
    ]) {
      expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
    }
    for (const folder of ['.', 'api', 'db', 'updater', 'backup', 'forms']) {
      expect(statSync(join(dir, folder)).mode & 0o077, folder).toBe(0);
    }

    expect(initSecrets(dir)).toEqual({ created: false, moved: [] });
    expect(readFileSync(join(dir, 'api/secrets.json'), 'utf8')).toContain(first.masterKey);
    expect(readAdminPassword(dir)).toBe(admin);
  });

  it('keep each service to its own folder: the API never holds the administrator password', () => {
    const dir = join(scratch, 'folders');
    initSecrets(dir);
    const api = readFileSync(join(dir, 'api/secrets.json'), 'utf8');
    expect(api).not.toContain(readAdminPassword(dir));
    expect(api).not.toContain('adminPassword');
    expect(readdirSync(join(dir, 'api'))).toEqual(['secrets.json']);
    expect(readdirSync(join(dir, 'db'))).toEqual(['admin-password']);
    expect(readdirSync(join(dir, 'updater'))).toEqual(['updater-key']);
    expect(readdirSync(join(dir, 'backup'))).toEqual(['backup-password']);
    expect(readdirSync(join(dir, 'forms')).sort()).toEqual(['db-password', 'form-key']);
    // An API file that still carries it is refused.
    const parsed = JSON.parse(api) as { db: Record<string, string> };
    parsed.db.adminPassword = 'x'.repeat(43);
    writeFileSync(join(dir, 'api/secrets.json'), JSON.stringify(parsed));
    expect(() => readSecrets(dir)).toThrow('malformed');
  });

  it('move out of the old single folder once, keeping every value', () => {
    const dir = join(scratch, 'old');
    mkdirSync(dir, { mode: 0o700 });
    const old = {
      version: 1,
      masterKey: Buffer.alloc(32, 7).toString('base64'),
      db: {
        adminPassword: 'a'.repeat(43),
        appPassword: 'b'.repeat(43),
        authPassword: 'c'.repeat(43),
      },
    };
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(old), { mode: 0o600 });
    writeFileSync(join(dir, 'db-admin-password'), old.db.adminPassword, { mode: 0o600 });
    writeFileSync(join(dir, 'updater-key'), 'chave-antiga', { mode: 0o600 });
    writeFileSync(join(dir, 'backup-password'), 'copias-antigas', { mode: 0o600 });
    writeFileSync(join(dir, 'rclone.conf'), '[drive]', { mode: 0o600 });
    writeFileSync(join(dir, 'setup-token'), 'token', { mode: 0o600 });

    const result = initSecrets(dir);
    expect(result.created).toBe(false);
    expect(result.moved.sort()).toEqual(
      [
        'backup-password',
        'db-admin-password',
        'rclone.conf',
        'secrets.json',
        'setup-token',
        'updater-key',
      ].sort(),
    );
    expect(readSecrets(dir)).toEqual({
      version: 2,
      masterKey: old.masterKey,
      db: { appPassword: old.db.appPassword, authPassword: old.db.authPassword },
    });
    expect(readAdminPassword(dir)).toBe(old.db.adminPassword);
    expect(readFileSync(join(dir, 'updater/updater-key'), 'utf8')).toBe('chave-antiga');
    expect(readFileSync(join(dir, 'backup/backup-password'), 'utf8')).toBe('copias-antigas');
    expect(readFileSync(join(dir, 'backup/rclone.conf'), 'utf8')).toBe('[drive]');
    expect(readFileSync(join(dir, 'api/setup-token'), 'utf8')).toBe('token');
    // Nothing is left at the top for a service that mounts the whole volume.
    expect(readdirSync(dir).sort()).toEqual(['api', 'backup', 'db', 'forms', 'updater']);
    expect(initSecrets(dir)).toEqual({ created: false, moved: [] });
  });

  it('refuse to make a new administrator password next to existing data', () => {
    const dir = join(scratch, 'half');
    initSecrets(dir);
    rmSync(join(dir, 'db/admin-password'));
    expect(() => initSecrets(dir)).toThrow('restore the other');
  });

  it('give the forms service only its folder, and it refuses anything more', () => {
    const dir = join(scratch, 'forms-only');
    initSecrets(dir);
    expect(readFormsSecrets(join(dir, 'forms')).formKey).toHaveLength(32);
    // The whole configuration mounted where its folder should be.
    expect(() => readFormsSecrets(dir)).toThrow();
    writeFileSync(join(dir, 'forms/extra'), 'x');
    expect(() => readFormsSecrets(join(dir, 'forms'))).toThrow('more than the forms secrets');
  });

  it('include the updater key, made also for installations that had none, and kept', () => {
    const dir = join(scratch, 'older');
    initSecrets(dir);
    const file = join(dir, 'updater/updater-key');
    const key = readFileSync(file, 'utf8');
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    initSecrets(dir);
    expect(readFileSync(file, 'utf8')).toBe(key);
    // An installation from before the updater gets one on its next start.
    rmSync(file);
    expect(initSecrets(dir)).toEqual({ created: false, moved: [] });
    expect(Buffer.from(readFileSync(file, 'utf8'), 'base64')).toHaveLength(32);
  });

  it('differ on every instance', () => {
    const a = join(scratch, 'a');
    const b = join(scratch, 'b');
    initSecrets(a);
    initSecrets(b);
    expect(readSecrets(a).masterKey).not.toBe(readSecrets(b).masterKey);
    expect(readSecrets(a).db.appPassword).not.toBe(readSecrets(b).db.appPassword);
    expect(readFileSync(join(a, 'backup/backup-password'), 'utf8')).not.toBe(
      readFileSync(join(b, 'backup/backup-password'), 'utf8'),
    );
  });

  it('are required: the server does not start with missing or damaged secrets', () => {
    expect(() => readSecrets(join(scratch, 'missing'))).toThrow();
    expect(() => readAdminPassword(join(scratch, 'missing'))).toThrow();
  });
});

describe('the public origin', () => {
  it('must be https in production and an origin only', () => {
    expect(parsePublicOrigin('https://cerebro.exemplo.com', 'production')).toBe(
      'https://cerebro.exemplo.com',
    );
    expect(() => parsePublicOrigin('http://cerebro.exemplo.com', 'production')).toThrow();
    expect(() => parsePublicOrigin('http://localhost:3000', 'production')).toThrow();
    expect(parsePublicOrigin('http://localhost:3000', 'development')).toBe('http://localhost:3000');
    expect(() => parsePublicOrigin('https://cerebro.exemplo.com/app', 'production')).toThrow();
    expect(() => parsePublicOrigin('cerebro.exemplo.com', 'production')).toThrow();
  });
});
