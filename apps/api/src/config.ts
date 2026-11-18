import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSecrets } from './secrets.js';

export interface Argon2Params {
  /** KiB */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  appPassword: string;
  authPassword: string;
}

export interface Config {
  env: 'production' | 'development' | 'test';
  /** Exact origin the app is served from, e.g. https://cerebro.exemplo.com */
  publicOrigin: string;
  listen: { host: string; port: number };
  /** True when running behind a reverse proxy that sets X-Forwarded-For. */
  trustProxy: boolean;
  /**
   * Requests one session (or, before signing in, one address) may make per
   * minute. Beyond it the API answers 429 until the minute passes.
   */
  requestsPerMinute: number;
  db: DbConfig;
  masterKey: Buffer;
  argon2: Argon2Params;
  /** Where the one-time first-run token is written. */
  setupTokenFile: string;
  /** Folder with the built web app, served by the API itself. Null runs the API alone. */
  webRoot: string | null;
  /** Where attachment content is kept, and the largest file accepted. */
  files: { dir: string; maxBytes: number };
  /**
   * The antivirus attachments go through. Null until the installation chooses:
   * attachments are refused meanwhile. "off" is a deliberate choice to keep
   * files marked as not checked.
   */
  antivirus: { kind: 'clamd'; host: string; port: number } | { kind: 'off' } | null;
  /** The version in use, written into the image when it is built. */
  version: string;
  /** Where the updater listens, and the key requests to it are signed with; null without one. */
  updater: { url: string; key: Buffer } | null;
  /** The backup service's situation file, read-only; null without the service. */
  backupStatusFile: string | null;
}

export function parseAntivirus(raw: string | undefined): Config['antivirus'] {
  if (raw === undefined || raw === '') return null;
  if (raw === 'off') return { kind: 'off' };
  const match = /^clamd:\/\/([A-Za-z0-9.-]+):(\d{1,5})$/.exec(raw);
  if (!match) throw new Error('CEREBRO_ANTIVIRUS must be "off" or clamd://host:port');
  return { kind: 'clamd', host: match[1] ?? '', port: Number(match[2]) };
}

/** OWASP-recommended range for argon2id; raise it if the server can afford it. */
export const DEFAULT_ARGON2: Argon2Params = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };

/** Enough for heavy use of the page; a script hammering the API is stopped. */
export const DEFAULT_REQUESTS_PER_MINUTE = 1200;

export function parseRequestsPerMinute(raw: string | undefined): number {
  const value = raw === undefined || raw === '' ? DEFAULT_REQUESTS_PER_MINUTE : Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 100_000) {
    throw new Error('CEREBRO_REQUESTS_PER_MINUTE must be a whole number from 60 to 100000');
  }
  return value;
}

/** 2 GB unless the installation says otherwise; never above 1 TB. */
function maxAttachmentBytes(raw: string | undefined): number {
  const megabytes = raw === undefined || raw === '' ? 2048 : Number(raw);
  if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > 1_048_576) {
    throw new Error('CEREBRO_MAX_ATTACHMENT_MB must be a whole number of megabytes');
  }
  return megabytes * 1024 * 1024;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`missing environment variable ${key}`);
  return value;
}

export function parsePublicOrigin(raw: string, env: Config['env']): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CEREBRO_PUBLIC_ORIGIN must be a URL such as https://cerebro.exemplo.com');
  }
  if (url.origin !== raw.replace(/\/$/, '')) {
    throw new Error('CEREBRO_PUBLIC_ORIGIN must be an origin only (scheme, host, optional port)');
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(env !== 'production' && isLocal)) {
    throw new Error('CEREBRO_PUBLIC_ORIGIN must use https');
  }
  return url.origin;
}

/** Reads non-secret settings from the environment and secrets from the config directory. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.CEREBRO_ENV ?? 'production';
  if (mode !== 'production' && mode !== 'development') {
    throw new Error('CEREBRO_ENV must be "production" or "development"');
  }
  const configDir = env.CEREBRO_CONFIG_DIR ?? '/opt/cerebro/config';
  const secrets = readSecrets(configDir);
  const port = Number(env.CEREBRO_PORT ?? '3000');
  const dbPort = Number(env.CEREBRO_DB_PORT ?? '5432');
  if (!Number.isInteger(port) || !Number.isInteger(dbPort)) throw new Error('invalid port');

  return {
    env: mode,
    publicOrigin: parsePublicOrigin(required(env, 'CEREBRO_PUBLIC_ORIGIN'), mode),
    listen: { host: env.CEREBRO_HOST ?? '127.0.0.1', port },
    trustProxy: env.CEREBRO_TRUST_PROXY === 'true',
    requestsPerMinute: parseRequestsPerMinute(env.CEREBRO_REQUESTS_PER_MINUTE),
    db: {
      host: required(env, 'CEREBRO_DB_HOST'),
      port: dbPort,
      database: env.CEREBRO_DB_NAME ?? 'cerebro',
      appPassword: secrets.db.appPassword,
      authPassword: secrets.db.authPassword,
    },
    masterKey: Buffer.from(secrets.masterKey, 'base64'),
    argon2: DEFAULT_ARGON2,
    setupTokenFile: join(configDir, 'setup-token'),
    webRoot:
      env.CEREBRO_WEB_ROOT === undefined || env.CEREBRO_WEB_ROOT === ''
        ? null
        : env.CEREBRO_WEB_ROOT,
    files: {
      dir: env.CEREBRO_FILES_DIR ?? '/opt/cerebro/files',
      maxBytes: maxAttachmentBytes(env.CEREBRO_MAX_ATTACHMENT_MB),
    },
    antivirus: parseAntivirus(env.CEREBRO_ANTIVIRUS),
    version: parseVersion(env.CEREBRO_VERSION),
    updater: parseUpdater(env.CEREBRO_UPDATER_URL, configDir),
    backupStatusFile:
      env.CEREBRO_BACKUP_STATUS === undefined || env.CEREBRO_BACKUP_STATUS === ''
        ? null
        : env.CEREBRO_BACKUP_STATUS,
  };
}

/** "1.2.3" (as released), or "dev" for a build that did not come from a release. */
export function parseVersion(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'dev';
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(raw))
    throw new Error('CEREBRO_VERSION must look like 1.2.3');
  return raw;
}

/** The updater is optional; when it is set, its key must be there (made by init-secrets). */
export function parseUpdater(raw: string | undefined, configDir: string): Config['updater'] {
  if (raw === undefined || raw === '') return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '') {
    throw new Error('CEREBRO_UPDATER_URL must be like http://updater:8080 (internal network only)');
  }
  let key: Buffer;
  try {
    key = Buffer.from(readFileSync(join(configDir, 'updater-key'), 'utf8').trim(), 'base64');
  } catch {
    throw new Error(
      'CEREBRO_UPDATER_URL is set but the updater key is missing; run "init-secrets"',
    );
  }
  if (key.length !== 32) throw new Error('the updater key is malformed');
  return { url: url.origin, key };
}
