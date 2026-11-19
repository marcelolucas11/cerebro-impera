import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { BackupEngine, isRestoreDay, nextRun, type Command } from './engine.js';

/*
 * The backup service as it runs in its own container: a copy every day at
 * the hour set (03h by default, in the container's time zone), the restore
 * test after the copy of the first day of each month. It has no Docker
 * socket and reads attachments and configuration without being able to
 * change them.
 */

const command: Command = {
  run: (args, options = {}) =>
    new Promise((resolve) => {
      const [program, ...rest] = args;
      if (program === undefined) {
        resolve({ code: 1, output: '' });
        return;
      }
      const child = spawn(program, rest, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '/tmp',
          TZ: process.env.TZ ?? 'UTC',
          // restic keeps its cache in the scratch space; rclone reads the destination set by
          // the maintainer in the configuration (never in the repository).
          RESTIC_CACHE_DIR: process.env.RESTIC_CACHE_DIR ?? '/work/.cache',
          RCLONE_CONFIG: join(process.env.CEREBRO_CONFIG_DIR ?? '/data/config', 'rclone.conf'),
          ...options.env,
        },
      });
      let output = '';
      const keep = (chunk: Buffer): void => {
        if (output.length < 1_000_000) output += chunk.toString('utf8');
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', () => undefined);
      child.on('error', () => {
        resolve({ code: 1, output });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, output });
      });
    }),
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const configDir = process.env.CEREBRO_CONFIG_DIR ?? '/data/config';
  const hour = Number(process.env.CEREBRO_BACKUP_HOUR ?? '3');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new Error('CEREBRO_BACKUP_HOUR must be 0 to 23');
  const engine = new BackupEngine(
    {
      repository: required('CEREBRO_BACKUP_REPOSITORY'),
      passwordFile: join(configDir, 'backup-password'),
      sources: ['/data/files', configDir],
      workDir: '/work',
      statusFile: process.env.CEREBRO_BACKUP_STATUS ?? '/status/backup.json',
      database: {
        host: process.env.CEREBRO_DB_HOST ?? 'postgres',
        name: process.env.CEREBRO_DB_NAME ?? 'cerebro',
        user: 'postgres',
        password: (await readFile(join(configDir, 'db-admin-password'), 'utf8')).trim(),
      },
      tag: process.env.CEREBRO_BACKUP_TAG ?? 'cerebro',
    },
    {
      command,
      disk: {
        write: (path, content) => writeFile(path, content, { mode: 0o644 }),
        read: (path) => readFile(path, 'utf8').catch(() => null),
        remove: (path) => rm(path, { recursive: true, force: true }),
      },
      now: () => new Date(),
    },
  );

  await engine.ensureRepository();
  // To check a new installation (and in the CI): a copy right away, and the restore test with it.
  const now = process.env.CEREBRO_BACKUP_NOW ?? '';
  if (now === 'backup' || now === 'backup+test') {
    await engine.backup(nextRun(new Date(), hour));
    if (now === 'backup+test') await engine.restoreTest();
  }
  for (;;) {
    const at = nextRun(new Date(), hour);
    const status = await engine.status();
    await writeFile(
      process.env.CEREBRO_BACKUP_STATUS ?? '/status/backup.json',
      `${JSON.stringify({ ...status, nextRunAt: at.toISOString() }, null, 2)}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at.getTime() - Date.now())));
    const done = await engine.backup(nextRun(new Date(Date.now() + 60_000), hour));
    process.stdout.write(`backup ${done.lastBackup?.ok === true ? 'ok' : 'failed'}\n`);
    if (isRestoreDay(at)) {
      const tested = await engine.restoreTest();
      process.stdout.write(
        `restore test ${tested.lastRestoreTest?.ok === true ? 'ok' : 'failed'}\n`,
      );
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'backup failed'}\n`);
  process.exit(1);
});
