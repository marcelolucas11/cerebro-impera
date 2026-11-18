import { describe, expect, it } from 'vitest';
import {
  BackupEngine,
  isRestoreDay,
  nextRun,
  RETENTION,
  summaryOf,
  type Ports,
  type Settings,
} from '../src/engine.js';

const settings: Settings = {
  repository: 'rclone:destino:cerebro',
  passwordFile: '/data/config/backup-password',
  sources: ['/data/files', '/data/config'],
  workDir: '/work',
  statusFile: '/status/backup.json',
  database: { host: 'postgres', name: 'cerebro', user: 'postgres', password: 'senha-do-banco' },
  tag: 'cerebro',
};

const SUMMARY = JSON.stringify({
  message_type: 'summary',
  snapshot_id: 'a1b2c3d4e5f6',
  total_bytes_processed: 52_428_800,
});

/** restic, PostgreSQL and the disk, stood in for. */
function world(options: { failing?: string; check?: string; repositoryExists?: boolean } = {}) {
  const files = new Map<string, string>();
  const runs: { line: string; env: Record<string, string> }[] = [];
  const removed: string[] = [];
  let clock = Date.UTC(2030, 5, 1, 6, 0, 0);
  const ports: Ports = {
    command: {
      run(args, io = {}) {
        const line = args.join(' ');
        runs.push({ line, env: io.env ?? {} });
        if (options.failing !== undefined && line.startsWith(options.failing)) {
          return Promise.resolve({ code: 1, output: '' });
        }
        if (line === 'restic cat config') {
          return Promise.resolve({ code: options.repositoryExists === false ? 1 : 0, output: '' });
        }
        if (line.startsWith('restic backup')) {
          return Promise.resolve({ code: 0, output: `{"message_type":"status"}\n${SUMMARY}\n` });
        }
        if (line.startsWith('psql') && line.includes('verify_chain')) {
          return Promise.resolve({ code: 0, output: `${options.check ?? '4 true'}\n` });
        }
        clock += 1_000;
        return Promise.resolve({ code: 0, output: '' });
      },
    },
    disk: {
      write: (path, content) => {
        files.set(path, content);
        return Promise.resolve();
      },
      read: (path) => Promise.resolve(files.get(path) ?? null),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    },
    now: () => new Date(clock),
  };
  return { engine: new BackupEngine(settings, ports), files, runs, removed };
}

describe('the daily copy', () => {
  it('copies the database, then sends it with attachments and configuration, then keeps a year', async () => {
    const { engine, runs, removed } = world();
    const status = await engine.backup(new Date(Date.UTC(2030, 5, 2, 6)));
    expect(status.lastBackup).toMatchObject({
      ok: true,
      snapshot: 'a1b2c3d4e5f6',
      bytes: 52_428_800,
      problem: null,
    });
    expect(status.lastSuccessAt).toBe(status.lastBackup?.finishedAt);
    expect(status.nextRunAt).toBe('2030-06-02T06:00:00.000Z');
    expect(runs.map((run) => run.line)).toEqual([
      'pg_dump --host postgres --username postgres --format custom --file /work/db.dump cerebro',
      'restic backup --json --tag cerebro /work/db.dump /data/files /data/config',
      `restic forget --tag cerebro ${RETENTION.join(' ')} --prune`,
    ]);
    expect(RETENTION).toEqual([
      '--keep-daily',
      '30',
      '--keep-weekly',
      '26',
      '--keep-monthly',
      '12',
    ]);
    // The database password only goes to pg_dump; the copies' key only to restic, by file.
    expect(runs[0]?.env).toEqual({ PGPASSWORD: 'senha-do-banco' });
    expect(runs[1]?.env).toEqual({
      RESTIC_REPOSITORY: 'rclone:destino:cerebro',
      RESTIC_PASSWORD_FILE: '/data/config/backup-password',
    });
    // The plain database copy never stays outside the encrypted repository.
    expect(removed).toContain('/work/db.dump');
  });

  it('says which step failed, keeps the last good copy on record, and still removes the plain copy', async () => {
    const { engine, removed } = world();
    const good = await engine.backup(null);
    for (const [step, problem] of [
      ['pg_dump', 'Não foi possível copiar o banco de dados.'],
      ['restic backup', 'Não foi possível gravar a cópia no destino.'],
      ['restic forget', 'A cópia foi feita, mas as antigas não puderam ser podadas.'],
    ] as const) {
      const failing = world({ failing: step });
      failing.files.set('/status/backup.json', JSON.stringify(good));
      const status = await failing.engine.backup(null);
      expect(status.lastBackup, step).toMatchObject({ ok: false, problem, snapshot: null });
      expect(status.lastSuccessAt, step).toBe(good.lastSuccessAt);
      expect(failing.removed, step).toContain('/work/db.dump');
    }
    expect(removed).toContain('/work/db.dump');
  });

  it('creates the repository only when there is none', async () => {
    const fresh = world({ repositoryExists: false });
    await fresh.engine.ensureRepository();
    expect(fresh.runs.map((run) => run.line)).toEqual(['restic cat config', 'restic init']);
    const existing = world();
    await existing.engine.ensureRepository();
    expect(existing.runs.map((run) => run.line)).toEqual(['restic cat config']);
  });

  it('reads the snapshot from restic, and nothing else', () => {
    expect(summaryOf(`não é json\n${SUMMARY}`)).toEqual({
      snapshot: 'a1b2c3d4e5f6',
      bytes: 52_428_800,
    });
    expect(summaryOf('{"message_type":"status"}')).toBeNull();
  });
});

describe('the monthly restore test', () => {
  it('restores the latest copy into a throwaway database and checks people and the audit trail', async () => {
    const { engine, runs, removed } = world();
    const status = await engine.restoreTest();
    expect(status.lastRestoreTest).toMatchObject({ ok: true, people: 4, problem: null });
    const lines = runs.map((run) => run.line);
    expect(lines[0]).toBe('restic check');
    expect(lines[1]).toBe(
      'restic restore latest --tag cerebro --target /work/teste/restaurado --include /work/db.dump',
    );
    expect(lines[2]).toBe('initdb --pgdata /work/teste/pg --username postgres --auth trust');
    // Local only: no address to listen on, just a socket inside the scratch space.
    expect(lines[3]).toBe(
      'pg_ctl --pgdata /work/teste/pg --options -k /work/teste/socket -c listen_addresses= --wait start',
    );
    expect(
      lines.some(
        (line) =>
          line.includes('pg_restore') && line.endsWith('/work/teste/restaurado/work/db.dump'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).toBe('pg_ctl --pgdata /work/teste/pg --mode immediate stop');
    expect(removed.at(-1)).toBe('/work/teste');
  });

  it('fails when the copy is empty, the trail is broken, or a step fails, and always cleans up', async () => {
    for (const [trouble, problem] of [
      [{ check: '0 true' }, 'A cópia restaurada não tem ninguém.'],
      [{ check: '4 false' }, 'A trilha de auditoria da cópia não está íntegra.'],
      [{ failing: 'restic check' }, 'O repositório das cópias não está íntegro.'],
      [{ failing: 'pg_restore' }, 'A cópia do banco não abriu.'],
    ] as const) {
      const { engine, runs, removed } = world(trouble);
      const status = await engine.restoreTest();
      expect(status.lastRestoreTest, problem).toMatchObject({ ok: false, problem, people: null });
      expect(removed.at(-1), problem).toBe('/work/teste');
      const started = runs.some((run) => run.line.endsWith('--wait start'));
      expect(runs.at(-1)?.line.endsWith('stop'), problem).toBe(started);
    }
  });
});

describe('when it runs', () => {
  it('runs at the hour of the day, tomorrow when today has passed', () => {
    const morning = new Date(2030, 5, 10, 1, 30);
    expect(nextRun(morning, 3)).toEqual(new Date(2030, 5, 10, 3, 0));
    expect(nextRun(new Date(2030, 5, 10, 3, 0), 3)).toEqual(new Date(2030, 5, 11, 3, 0));
    expect(nextRun(new Date(2030, 5, 30, 23, 0), 3)).toEqual(new Date(2030, 6, 1, 3, 0));
  });

  it('tests a restore on the first day of the month', () => {
    expect(isRestoreDay(new Date(2030, 6, 1, 3))).toBe(true);
    expect(isRestoreDay(new Date(2030, 6, 2, 3))).toBe(false);
  });
});
