import { join } from 'node:path';

/*
 * The daily copy and the monthly restore test. Every program runs from a
 * fixed list of arguments, never through a shell; restic, PostgreSQL and the
 * disk sit behind small interfaces so the tests can stand in for them.
 */

export interface Command {
  run(
    args: readonly string[],
    options?: { env?: Record<string, string> },
  ): Promise<{ code: number; output: string }>;
}

export interface Disk {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

export interface Settings {
  /** Where restic keeps the copies: a local path, or rclone:<remote>:<folder>. */
  repository: string;
  /** The file with the key of the copies (made by init-secrets). */
  passwordFile: string;
  /** What goes into each copy besides the database. */
  sources: readonly string[];
  /** Scratch space, emptied after each run. */
  workDir: string;
  /** Where the situation is written for the API to read. */
  statusFile: string;
  database: { host: string; name: string; user: string; password: string };
  /** Marks every copy, so a repository shared by mistake never mixes installations. */
  tag: string;
}

export interface Ports {
  command: Command;
  disk: Disk;
  now: () => Date;
}

export interface BackupStatus {
  lastBackup: {
    startedAt: string;
    finishedAt: string;
    ok: boolean;
    snapshot: string | null;
    bytes: number | null;
    /** In words, for the owners, when it went wrong. */
    problem: string | null;
  } | null;
  lastSuccessAt: string | null;
  lastRestoreTest: {
    at: string;
    ok: boolean;
    people: number | null;
    problem: string | null;
  } | null;
  nextRunAt: string | null;
}

class StepFailed extends Error {
  constructor(readonly problem: string) {
    super(problem);
  }
}

/** Thirty daily, twenty-six weekly, twelve monthly: a year. */
export const RETENTION = ['--keep-daily', '30', '--keep-weekly', '26', '--keep-monthly', '12'];

/** The snapshot and size from `restic backup --json`, read from its summary line. */
export function summaryOf(output: string): { snapshot: string; bytes: number } | null {
  for (const line of output.split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as {
        message_type?: unknown;
        snapshot_id?: unknown;
        total_bytes_processed?: unknown;
      };
      if (parsed.message_type === 'summary' && typeof parsed.snapshot_id === 'string') {
        return {
          snapshot: parsed.snapshot_id,
          bytes:
            typeof parsed.total_bytes_processed === 'number' ? parsed.total_bytes_processed : 0,
        };
      }
    } catch {
      // Progress lines and anything else are skipped.
    }
  }
  return null;
}

export class BackupEngine {
  constructor(
    private readonly settings: Settings,
    private readonly ports: Ports,
  ) {}

  private get resticEnv(): Record<string, string> {
    return {
      RESTIC_REPOSITORY: this.settings.repository,
      RESTIC_PASSWORD_FILE: this.settings.passwordFile,
    };
  }

  private async must(
    args: readonly string[],
    problem: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const result = await this.ports.command.run(args, { env });
    if (result.code !== 0) throw new StepFailed(problem);
    return result.output;
  }

  async status(): Promise<BackupStatus> {
    const raw = await this.ports.disk.read(this.settings.statusFile);
    if (raw !== null) {
      try {
        return JSON.parse(raw) as BackupStatus;
      } catch {
        // A damaged file is started over.
      }
    }
    return { lastBackup: null, lastSuccessAt: null, lastRestoreTest: null, nextRunAt: null };
  }

  private async save(status: BackupStatus): Promise<void> {
    await this.ports.disk.write(this.settings.statusFile, `${JSON.stringify(status, null, 2)}\n`);
  }

  /** Creates the repository the first time; an existing one is left as it is. */
  async ensureRepository(): Promise<void> {
    const exists = await this.ports.command.run(['restic', 'cat', 'config'], {
      env: this.resticEnv,
    });
    if (exists.code === 0) return;
    await this.must(
      ['restic', 'init'],
      'Não foi possível criar o repositório das cópias.',
      this.resticEnv,
    );
  }

  /** One copy: the database, the attachments and the configuration, then the year is trimmed. */
  async backup(nextRunAt: Date | null): Promise<BackupStatus> {
    const status = await this.status();
    const startedAt = this.ports.now().toISOString();
    const dump = join(this.settings.workDir, 'db.dump');
    const { database } = this.settings;
    let result: NonNullable<BackupStatus['lastBackup']>;
    try {
      await this.must(
        [
          'pg_dump',
          '--host',
          database.host,
          '--username',
          database.user,
          '--format',
          'custom',
          '--file',
          dump,
          database.name,
        ],
        'Não foi possível copiar o banco de dados.',
        { PGPASSWORD: database.password },
      );
      const output = await this.must(
        ['restic', 'backup', '--json', '--tag', this.settings.tag, dump, ...this.settings.sources],
        'Não foi possível gravar a cópia no destino.',
        this.resticEnv,
      );
      const summary = summaryOf(output);
      if (summary === null) throw new StepFailed('A cópia não confirmou o que gravou.');
      await this.must(
        ['restic', 'forget', '--tag', this.settings.tag, ...RETENTION, '--prune'],
        'A cópia foi feita, mas as antigas não puderam ser podadas.',
        this.resticEnv,
      );
      result = {
        startedAt,
        finishedAt: this.ports.now().toISOString(),
        ok: true,
        snapshot: summary.snapshot,
        bytes: summary.bytes,
        problem: null,
      };
    } catch (error) {
      result = {
        startedAt,
        finishedAt: this.ports.now().toISOString(),
        ok: false,
        snapshot: null,
        bytes: null,
        problem: error instanceof StepFailed ? error.problem : 'Falha inesperada na cópia.',
      };
    } finally {
      // The database copy never stays outside the encrypted repository.
      await this.ports.disk.remove(dump).catch(() => undefined);
    }
    const next: BackupStatus = {
      ...status,
      lastBackup: result,
      lastSuccessAt: result.ok ? result.finishedAt : status.lastSuccessAt,
      nextRunAt: nextRunAt === null ? null : nextRunAt.toISOString(),
    };
    await this.save(next);
    return next;
  }

  /**
   * Restores the latest copy of the database into a throwaway PostgreSQL inside this
   * container (no network) and checks that people are there and the audit trail holds.
   */
  async restoreTest(): Promise<BackupStatus> {
    const status = await this.status();
    const work = join(this.settings.workDir, 'teste');
    const target = join(work, 'restaurado');
    const data = join(work, 'pg');
    // The socket goes in the data folder, which exists once initdb has run: the server
    // will not create a missing folder for it.
    const socket = data;
    const dump = join(target, this.settings.workDir, 'db.dump');
    const psql = (sql: string): string[] => [
      'psql',
      '--host',
      socket,
      '--username',
      'postgres',
      '--dbname',
      'cerebro',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ];
    let result: NonNullable<BackupStatus['lastRestoreTest']>;
    let started = false;
    try {
      await this.ports.disk.remove(work);
      await this.must(
        ['restic', 'check'],
        'O repositório das cópias não está íntegro.',
        this.resticEnv,
      );
      await this.must(
        [
          'restic',
          'restore',
          'latest',
          '--tag',
          this.settings.tag,
          '--target',
          target,
          '--include',
          join(this.settings.workDir, 'db.dump'),
        ],
        'A cópia mais recente não pôde ser restaurada.',
        this.resticEnv,
      );
      await this.must(
        ['initdb', '--pgdata', data, '--username', 'postgres', '--auth', 'trust'],
        'O banco descartável não pôde ser criado.',
      );
      await this.must(
        [
          'pg_ctl',
          '--pgdata',
          data,
          '--options',
          `-k ${socket} -c listen_addresses=`,
          '--wait',
          'start',
        ],
        'O banco descartável não subiu.',
      );
      started = true;
      await this.must(
        [
          'psql',
          '--host',
          socket,
          '--username',
          'postgres',
          '--dbname',
          'postgres',
          '--set',
          'ON_ERROR_STOP=1',
          // CREATE DATABASE cannot share a command with anything else.
          '--command',
          'CREATE DATABASE cerebro',
          '--command',
          'CREATE ROLE cerebro_app NOLOGIN; CREATE ROLE cerebro_auth NOLOGIN;',
        ],
        'O banco descartável não pôde ser preparado.',
      );
      await this.must(
        [
          'pg_restore',
          '--host',
          socket,
          '--username',
          'postgres',
          '--dbname',
          'cerebro',
          '--exit-on-error',
          dump,
        ],
        'A cópia do banco não abriu.',
      );
      const answer = await this.must(
        psql(
          "SELECT (SELECT count(*) FROM app.users)::text || ' ' || (SELECT ok::text FROM audit.verify_chain())",
        ),
        'Os dados restaurados não puderam ser conferidos.',
      );
      const [people, chain] = answer.trim().split(' ');
      const count = Number(people);
      if (!Number.isInteger(count) || count < 1)
        throw new StepFailed('A cópia restaurada não tem ninguém.');
      if (chain !== 'true')
        throw new StepFailed('A trilha de auditoria da cópia não está íntegra.');
      result = { at: this.ports.now().toISOString(), ok: true, people: count, problem: null };
    } catch (error) {
      result = {
        at: this.ports.now().toISOString(),
        ok: false,
        people: null,
        problem: error instanceof StepFailed ? error.problem : 'Falha inesperada no teste.',
      };
    } finally {
      if (started)
        await this.ports.command.run(['pg_ctl', '--pgdata', data, '--mode', 'immediate', 'stop']);
      await this.ports.disk.remove(work).catch(() => undefined);
    }
    const next: BackupStatus = { ...status, lastRestoreTest: result };
    await this.save(next);
    return next;
  }
}

/** The next run at this hour of the day, local time; tomorrow when today's has passed. */
export function nextRun(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** The restore test runs after the copy of the first day of each month. */
export function isRestoreDay(day: Date): boolean {
  return day.getDate() === 1;
}
