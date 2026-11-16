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
  db: DbConfig;
  masterKey: Buffer;
  argon2: Argon2Params;
  /** Where the one-time first-run token is written. */
  setupTokenFile: string;
  /** Folder with the built web app, served by the API itself. Null runs the API alone. */
  webRoot: string | null;
}

/** OWASP-recommended range for argon2id; raise it if the server can afford it. */
export const DEFAULT_ARGON2: Argon2Params = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };

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
  };
}
