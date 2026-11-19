import pg from 'pg';
import { parsePublicOrigin, parseTrustProxy } from '../config.js';
import { readFormsSecrets } from '../secrets.js';
import { buildFormsApp } from './server.js';

/*
 * Starts the forms service. It reads only its own folder of secrets (mounted
 * alone, without the rest of the configuration) and connects to the database
 * as the role that can only show and send forms.
 */
export async function serveForms(): Promise<void> {
  const env = process.env;
  const mode = env.CEREBRO_ENV ?? 'production';
  if (mode !== 'production' && mode !== 'development') {
    throw new Error('CEREBRO_ENV must be "production" or "development"');
  }
  const raw = env.CEREBRO_FORMS_ORIGIN;
  if (raw === undefined || raw === '') throw new Error('missing CEREBRO_FORMS_ORIGIN');
  const origin = parsePublicOrigin(raw, mode);
  const host = env.CEREBRO_DB_HOST;
  if (host === undefined || host === '') throw new Error('missing CEREBRO_DB_HOST');
  const port = Number(env.CEREBRO_FORMS_PORT ?? '3001');
  const dbPort = Number(env.CEREBRO_DB_PORT ?? '5432');
  if (!Number.isInteger(port) || !Number.isInteger(dbPort)) throw new Error('invalid port');
  const secrets = readFormsSecrets(env.CEREBRO_FORMS_CONFIG_DIR ?? '/opt/cerebro/forms-config');

  const pool = new pg.Pool({
    host,
    port: dbPort,
    database: env.CEREBRO_DB_NAME ?? 'cerebro',
    user: 'cerebro_forms',
    password: secrets.dbPassword,
    max: 5,
    statement_timeout: 10_000,
    lock_timeout: 5_000,
    application_name: 'cerebro-forms',
  });
  const app = await buildFormsApp({
    pool,
    key: secrets.formKey,
    origin,
    trustProxy: parseTrustProxy(env.CEREBRO_TRUST_PROXY),
    now: () => Date.now(),
    logger: true,
  });

  const shutdown = (): void => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await app.listen({ host: env.CEREBRO_HOST ?? '127.0.0.1', port });
}
