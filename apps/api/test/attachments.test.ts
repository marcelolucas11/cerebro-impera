import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeAttachments, resumeScans } from '../src/modules/attachments.js';
import { createTestEnv, EICAR, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Attachments: who may send, see and download them; that nothing unchecked is
 * ever handed out; that what lies on disk reveals nothing; and that nothing is
 * removed before its time. First through the API, then at the database.
 */

const PART = 8 * 1024 * 1024;

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}
interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string | null;
  status: string;
  scanned: boolean;
  trashedAt: string | null;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let filesDir: string;

async function start(person: Person, item: string, name: string, size: number, type = '') {
  return person.browser.post<{ id: string; partSize: number; parts: number } & ErrorBody>(
    `/api/items/${item}/attachments`,
    { name, size, type },
  );
}

/** Sends a whole file in parts and finishes it. */
async function upload(
  person: Person,
  item: string,
  name: string,
  content: Buffer,
  type = 'application/octet-stream',
): Promise<Attachment> {
  const started = await start(person, item, name, content.length, type);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  for (let n = 0; n < started.body.parts; n += 1) {
    const sent = await person.browser.bytes(
      'PUT',
      `/api/uploads/${started.body.id}/parts/${n}`,
      content.subarray(n * PART, (n + 1) * PART),
    );
    expect(sent.status, sent.body.toString()).toBe(200);
  }
  const finished = await person.browser.post<Attachment>(`/api/uploads/${started.body.id}/finish`);
  expect(finished.status, JSON.stringify(finished.body)).toBe(200);
  return finished.body;
}

/** Waits for the antivirus to give its answer. */
async function settled(person: Person, item: string, id: string): Promise<Attachment> {
  for (let attemptNumber = 0; attemptNumber < 100; attemptNumber += 1) {
    const list = await person.browser.get<Attachment[]>(`/api/items/${item}/attachments`);
    const found = list.body.find((attachment) => attachment.id === id);
    if (found && found.status !== 'scanning') return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the antivirus never answered');
}

const download = (person: Person, id: string, headers: Record<string, string> = {}, query = '') =>
  person.browser.bytes('GET', `/api/attachments/${id}/content${query}`, undefined, headers);

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  filesDir = env.deps.config.files.dir;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('sending a file', () => {
  it('in parts, checked, and given back exactly as it was', async () => {
    const content = randomBytes(PART * 2 + 12_345);
    const sent = await upload(s.ana, s.itemAna, 'relatório final.bin', content);
    expect(sent).toMatchObject({
      name: 'relatório final.bin',
      size: content.length,
      status: 'scanning',
    });
    const ready = await settled(s.ana, s.itemAna, sent.id);
    expect(ready).toMatchObject({ status: 'ready', scanned: true, type: null });

    const got = await download(s.ana, sent.id);
    expect(got.status).toBe(200);
    expect(createHash('sha256').update(got.body).digest('hex')).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-disposition']).toBe(
      `attachment; filename="relat_rio final.bin"; filename*=UTF-8''relat%C3%B3rio%20final.bin`,
    );
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['cache-control']).toBe('no-store');
  });

  it('can stop and continue: the server says which parts it already has', async () => {
    const content = randomBytes(PART + 10);
    const started = await start(s.ana, s.itemAna, 'retomado.bin', content.length);
    expect(started.body.parts).toBe(2);
    await s.ana.browser.bytes(
      'PUT',
      `/api/uploads/${started.body.id}/parts/1`,
      content.subarray(PART),
    );
    const state = await s.ana.browser.get<{ received: number[] }>(
      `/api/uploads/${started.body.id}`,
    );
    expect(state.body).toEqual({ partSize: PART, parts: 2, received: [1] });
    const early = await s.ana.browser.post<ErrorBody>(`/api/uploads/${started.body.id}/finish`);
    expect(early.status).toBe(409);
    await s.ana.browser.bytes(
      'PUT',
      `/api/uploads/${started.body.id}/parts/0`,
      content.subarray(0, PART),
    );
    expect((await s.ana.browser.post(`/api/uploads/${started.body.id}/finish`)).status).toBe(200);
    await settled(s.ana, s.itemAna, started.body.id);
    expect((await download(s.ana, started.body.id)).body.equals(content)).toBe(true);
  });

  it('refuses parts that do not fit, files too large, and names that could be paths', async () => {
    const started = await start(s.ana, s.itemAna, 'curto.txt', 100);
    const id = started.body.id;
    for (const [n, size] of [
      [0, 99],
      [0, 101],
      [1, 100],
    ] as const) {
      const bad = await s.ana.browser.bytes(
        'PUT',
        `/api/uploads/${id}/parts/${n}`,
        randomBytes(size),
      );
      expect(bad.status, `${n}:${size}`).toBe(400);
    }
    const tooLarge = await start(s.ana, s.itemAna, 'enorme.bin', 21 * 1024 * 1024);
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.code).toBe('file_too_large');
    for (const name of ['../../etc/passwd', 'a/b', 'a\\b', 'linha\nnova', '']) {
      expect((await start(s.ana, s.itemAna, name, 10)).status, name).toBe(400);
    }
    // A part larger than any part is refused before it is even read.
    const huge = await s.ana.browser.bytes(
      'PUT',
      `/api/uploads/${id}/parts/0`,
      Buffer.alloc(PART + 1),
    );
    expect(huge.status).toBe(413);
  });

  it('keeps on disk only noise: no name, and content that cannot be read without the key', async () => {
    const secret = Buffer.from('CONTEÚDO CONFIDENCIAL DO CLIENTE '.repeat(1000));
    const sent = await upload(s.ana, s.itemAna, 'segredo-do-cliente.txt', secret, 'text/plain');
    const folders = readdirSync(filesDir);
    expect(folders).toContain(sent.id);
    expect(folders.join(' ')).not.toContain('segredo');
    const onDisk = readFileSync(join(filesDir, sent.id, '0'));
    expect(onDisk.includes(Buffer.from('CONFIDENCIAL'))).toBe(false);
    expect(onDisk.length).toBeGreaterThan(secret.length);
  });

  it('notices content altered or swapped on disk, and refuses to hand it out', async () => {
    const one = await upload(s.ana, s.itemAna, 'um.bin', randomBytes(64));
    const two = await upload(s.ana, s.itemAna, 'dois.bin', randomBytes(64));
    await settled(s.ana, s.itemAna, two.id);
    // Someone with access to the disk copies one file's part over another's.
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(filesDir, one.id, '0'), join(filesDir, two.id, '0'));
    const got = await download(s.ana, two.id);
    expect(got.status).toBe(500);
    expect(got.body.toString()).not.toContain('stack');
  });
});

describe('the antivirus', () => {
  it('blocks an infected file: nobody downloads it, and the owners are told', async () => {
    const sent = await upload(s.ana, s.itemAna, 'nota.com', Buffer.from(EICAR));
    const result = await settled(s.ana, s.itemAna, sent.id);
    expect(result).toMatchObject({ status: 'blocked', scanned: true });
    for (const person of [s.ana, s.owner]) {
      const got = await download(person, sent.id);
      expect(got.status).toBe(409);
    }
    const alerts = await env.admin.query<{ kind: string; severity: string }>(
      `SELECT kind, severity FROM app.security_alerts WHERE metadata ->> 'attachment_id' = $1`,
      [sent.id],
    );
    expect(alerts.rows).toEqual([{ kind: 'attachment_infected', severity: 'critical' }]);
  });

  it('lets nothing out before it has answered', async () => {
    const started = await start(s.ana, s.itemAna, 'esperando.bin', 10);
    await s.ana.browser.bytes('PUT', `/api/uploads/${started.body.id}/parts/0`, randomBytes(10));
    // Not finished: not even listed for others, and not downloadable for anyone.
    expect((await download(s.ana, started.body.id)).status).toBe(404);
    const owners = await s.owner.browser.get<Attachment[]>(`/api/items/${s.itemAna}/attachments`);
    expect(owners.body.map((a) => a.id)).not.toContain(started.body.id);
    // Finished but still being checked: listed, and refused.
    await env.admin.query(
      `UPDATE app.attachments SET status = 'scanning', finished_at = now(),
      sha256 = sha256('x') WHERE id = $1`,
      [started.body.id],
    );
    const waiting = await download(s.ana, started.body.id);
    expect(waiting.status).toBe(409);
  });

  it('is asked only once the upload is closed for good, however fast it answers', async () => {
    const working = env.deps.scanner;
    const errors: unknown[] = [];
    // Answers at once, without reading: the slowest part left is the database's commit.
    env.deps.scanner = { scan: () => Promise.resolve('clean') };
    try {
      for (let round = 0; round < 5; round += 1) {
        const sent = await upload(s.ana, s.itemAna, `rapido-${round}.txt`, Buffer.from('já'));
        expect((await settled(s.ana, s.itemAna, sent.id)).status).toBe('ready');
      }
    } finally {
      env.deps.scanner = working;
    }
    expect(errors).toEqual([]);
  });

  it('when it cannot be reached, files wait, and are checked once it is back, once each', async () => {
    const working = env.deps.scanner;
    if (working === null) throw new Error('the tests run with an antivirus');
    env.deps.scanner = { scan: () => Promise.reject(new Error('antivírus fora do ar')) };
    const sent = await upload(s.ana, s.itemAna, 'paciente.txt', Buffer.from('espera'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Unanswered is never "clean".
    expect((await download(s.ana, sent.id)).status).toBe(409);

    let handed = 0;
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    env.deps.scanner = {
      async scan(chunks) {
        handed += 1;
        await gate;
        return working.scan(chunks);
      },
    };
    const waiting = await env.admin.query(
      `SELECT 1 FROM app.attachments WHERE status = 'scanning'`,
    );
    const errors: unknown[] = [];
    // The hourly round can meet a check still under way: it is not started twice.
    await resumeScans(env.deps, (error) => errors.push(error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await resumeScans(env.deps, (error) => errors.push(error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handed).toBe(waiting.rowCount);
    open();
    expect(await settled(s.ana, s.itemAna, sent.id)).toMatchObject({
      status: 'ready',
      scanned: true,
    });
    for (let round = 0; round < 100; round += 1) {
      const left = await env.admin.query(`SELECT 1 FROM app.attachments WHERE status = 'scanning'`);
      if (left.rowCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(handed).toBe(waiting.rowCount);
    expect(errors).toEqual([]);
    env.deps.scanner = working;
  });
});

describe('who sees what', () => {
  it('follows the item: colleagues and outsiders get nothing, not even the name', async () => {
    const sent = await upload(s.ana, s.itemAna, 'só-da-ana.txt', Buffer.from('dela'));
    await settled(s.ana, s.itemAna, sent.id);
    for (const person of [s.bruno, s.nuno]) {
      expect((await person.browser.get(`/api/items/${s.itemAna}/attachments`)).status).toBe(404);
      expect((await download(person, sent.id)).status).toBe(404);
      expect((await person.browser.post(`/api/attachments/${sent.id}/trash`)).status).toBe(404);
    }
    expect((await download(s.owner, sent.id)).status).toBe(200);
    expect((await download(s.marta, sent.id)).status).toBe(200);
    // Bruno cannot attach anything to Ana's item either.
    expect((await start(s.bruno, s.itemAna, 'intruso.txt', 5)).status).toBe(404);
  });

  it('an upload belongs to its sender until it is finished', async () => {
    const started = await start(s.owner, s.itemAna, 'do-dono.bin', 10);
    const id = started.body.id;
    expect((await s.ana.browser.get(`/api/uploads/${id}`)).status).toBe(404);
    expect(
      (await s.ana.browser.bytes('PUT', `/api/uploads/${id}/parts/0`, randomBytes(10))).status,
    ).toBe(404);
    expect((await s.ana.browser.post(`/api/uploads/${id}/finish`)).status).toBe(404);
    expect((await s.ana.browser.delete(`/api/uploads/${id}`)).status).toBe(404);
    expect((await s.owner.browser.delete(`/api/uploads/${id}`)).status).toBe(200);
  });

  it('of a sensitive list needs a recent second factor, and each download is on the record', async () => {
    const sent = await upload(s.owner, s.itemMoney, 'extrato.pdf', Buffer.from('%PDF-1.7 extrato'));
    await settled(s.owner, s.itemMoney, sent.id);
    expect((await download(s.owner, sent.id)).status).toBe(200);
    const record = await env.admin.query(
      `SELECT 1 FROM audit.log WHERE action = 'attachment.downloaded' AND target_id = $1`,
      [sent.id],
    );
    expect(record.rowCount).toBe(1);
    await expireStepUp(env, s.owner);
    expect((await download(s.owner, sent.id)).status).toBe(404);
    // Asked through its list, the answer says what to do: confirm the code first.
    const through = `/api/lists/${s.dinheiro}/attachments/${sent.id}`;
    const asked = await s.owner.browser.get<ErrorBody>(through);
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    const confirmed = await s.owner.browser.get<Attachment>(through);
    expect(confirmed.body).toMatchObject({ id: sent.id, status: 'ready' });
    // Looking it up is not a download: still one line on the record.
    const after = await env.admin.query(
      `SELECT 1 FROM audit.log WHERE action = 'attachment.downloaded' AND target_id = $1`,
      [sent.id],
    );
    expect(after.rowCount).toBe(1);
  });

  it('asked through a list, only through its own, and only by who sees the item', async () => {
    const sent = await upload(s.ana, s.itemAna, 'pela-lista.txt', Buffer.from('lista'));
    const own = `/api/lists/${s.tarefas}/attachments/${sent.id}`;
    expect((await s.ana.browser.get<Attachment>(own)).body).toMatchObject({ id: sent.id });
    expect((await s.marta.browser.get(own)).status).toBe(200);
    expect((await s.bruno.browser.get(own)).status).toBe(404);
    expect((await s.nuno.browser.get(own)).status).toBe(404);
    const elsewhere = await s.owner.browser.get(`/api/lists/${s.dinheiro}/attachments/${sent.id}`);
    expect(elsewhere.status).toBe(404);
  });
});

describe('showing a file in the page', () => {
  it('only for kinds that cannot run anything, and only as what the content really is', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(100),
    ]);
    const image = await upload(s.ana, s.itemAna, 'foto.png', png, 'image/png');
    await settled(s.ana, s.itemAna, image.id);
    const shown = await download(s.ana, image.id, {}, '?inline=1');
    expect(shown.headers['content-type']).toBe('image/png');
    expect(String(shown.headers['content-disposition'])).toMatch(/^inline;/);

    // A page pretending to be a picture stays a download, whatever it claims.
    const page = await upload(
      s.ana,
      s.itemAna,
      'foto.png',
      Buffer.from('<script>alert(1)</script>'),
      'image/png',
    );
    await settled(s.ana, s.itemAna, page.id);
    const asked = await download(s.ana, page.id, {}, '?inline=1');
    expect(asked.headers['content-type']).toBe('application/octet-stream');
    expect(String(asked.headers['content-disposition'])).toMatch(/^attachment;/);
    const svg = await upload(
      s.ana,
      s.itemAna,
      'logo.svg',
      Buffer.from('<svg onload="alert(1)"/>'),
      'image/svg+xml',
    );
    await settled(s.ana, s.itemAna, svg.id);
    expect((await download(s.ana, svg.id, {}, '?inline=1')).headers['content-type']).toBe(
      'application/octet-stream',
    );
  });

  it('plays audio and video from any point, sending only the bytes asked for', async () => {
    const content = randomBytes(PART + 5000);
    const sent = await upload(s.ana, s.itemAna, 'longo.bin', content);
    await settled(s.ana, s.itemAna, sent.id);
    for (const [header, from, to] of [
      ['bytes=0-99', 0, 99],
      [`bytes=${PART - 10}-${PART + 10}`, PART - 10, PART + 10],
      [`bytes=${PART + 4000}-`, PART + 4000, content.length - 1],
    ] as const) {
      const part = await download(s.ana, sent.id, { range: header });
      expect(part.status, header).toBe(206);
      expect(part.body.equals(content.subarray(from, to + 1)), header).toBe(true);
      expect(part.headers['content-range']).toBe(`bytes ${from}-${to}/${content.length}`);
    }
    expect((await download(s.ana, sent.id, { range: `bytes=${content.length + 1}-` })).status).toBe(
      416,
    );
  });
});

describe('removing a file', () => {
  it('sends it to the trash, from where it comes back; the history tells both', async () => {
    const sent = await upload(s.ana, s.itemAna, 'para-tirar.txt', Buffer.from('tirar'));
    await settled(s.ana, s.itemAna, sent.id);
    expect((await s.ana.browser.post(`/api/attachments/${sent.id}/trash`)).status).toBe(200);
    const listed = await s.ana.browser.get<Attachment[]>(`/api/items/${s.itemAna}/attachments`);
    expect(listed.body.map((a) => a.id)).not.toContain(sent.id);
    const binned = await s.ana.browser.get<Attachment[]>(
      `/api/items/${s.itemAna}/attachments?trash=1`,
    );
    expect(binned.body.map((a) => a.id)).toContain(sent.id);
    expect((await download(s.ana, sent.id)).status).toBe(404);
    expect((await s.ana.browser.post(`/api/attachments/${sent.id}/restore`)).status).toBe(200);
    expect((await download(s.ana, sent.id)).status).toBe(200);

    const story = await s.ana.browser.get<{ what: string; new: unknown }[]>(
      `/api/items/${s.itemAna}/history`,
    );
    const mine = story.body.filter((c) => (c.new as { id?: string } | null)?.id === sent.id);
    expect(mine.map((c) => c.what)).toEqual([
      'attachment_restored',
      'attachment_removed',
      'attachment_added',
    ]);
  });

  it('for good only after thirty days, or a day for an upload left unfinished; the content is wiped', async () => {
    const old = await upload(s.ana, s.itemAna, 'velho.txt', Buffer.from('velho'));
    await settled(s.ana, s.itemAna, old.id);
    await s.ana.browser.post(`/api/attachments/${old.id}/trash`);
    const recent = await upload(s.ana, s.itemAna, 'recente.txt', Buffer.from('recente'));
    await settled(s.ana, s.itemAna, recent.id);
    await s.ana.browser.post(`/api/attachments/${recent.id}/trash`);
    const left = await start(s.ana, s.itemAna, 'largado.bin', 10);
    await s.ana.browser.bytes('PUT', `/api/uploads/${left.body.id}/parts/0`, randomBytes(10));

    await env.admin.query('ALTER TABLE app.attachments DISABLE TRIGGER keep');
    try {
      await env.admin.query(
        `UPDATE app.attachments SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [old.id],
      );
      await env.admin.query(
        `UPDATE app.attachments SET deleted_at = now() - interval '29 days' WHERE id = $1`,
        [recent.id],
      );
      await env.admin.query(
        `UPDATE app.attachments SET created_at = now() - interval '25 hours' WHERE id = $1`,
        [left.body.id],
      );
    } finally {
      await env.admin.query('ALTER TABLE app.attachments ENABLE TRIGGER keep');
    }
    expect(await purgeAttachments(env.deps)).toBe(2);
    const folders = readdirSync(filesDir);
    expect(folders).not.toContain(old.id);
    expect(folders).not.toContain(left.body.id);
    expect(folders).toContain(recent.id);
  });
});

describe('straight at the database', () => {
  it('nobody marks a file as checked, sets its digest, or forges who sent it', async () => {
    const started = await start(s.ana, s.itemAna, 'direto.bin', 10);
    const id = started.body.id;
    expect(await bind(app, s.ana)).toBe(true);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.attachments SET status = 'ready' WHERE id = $1`, [id]],
      [`UPDATE app.attachments SET scan_result = 'clean' WHERE id = $1`, [id]],
      [`UPDATE app.attachments SET sha256 = sha256('x') WHERE id = $1`, [id]],
      [`UPDATE app.attachments SET created_by = $1 WHERE id = $2`, [s.bruno.id, id]],
      [`UPDATE app.attachments SET name = 'outro' WHERE id = $1`, [id]],
      [`UPDATE app.attachments SET item_id = $1 WHERE id = $2`, [s.itemNobody, id]],
      [`DELETE FROM app.attachments WHERE id = $1`, [id]],
      [
        `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key, status)
         VALUES (gen_random_uuid(), $1, 'pronto', 1, '', '\\x00', 'ready')`,
        [s.itemAna],
      ],
      [
        `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key, created_by)
         VALUES (gen_random_uuid(), $1, 'forjado', 1, '', '\\x00', $2)`,
        [s.itemAna, s.bruno.id],
      ],
      // The antivirus' answer comes once, for something it was asked about.
      [`SELECT app.record_scan($1, 'clean')`, [id]],
      // The queue of content to wipe is not the application's to read or fill.
      [`SELECT * FROM app.attachment_disposals`, []],
      [`INSERT INTO app.attachment_disposals (attachment_id) VALUES ($1)`, [id]],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(result.ok && (result.rowCount > 0 || text.startsWith('SELECT')), text).toBe(false);
    }
    await app.query('ROLLBACK');
  });

  it('only the sender sends parts, sees them, and finishes, and only while the upload is open', async () => {
    const content = randomBytes(PART + 10);
    const started = await start(s.ana, s.itemAna, 'só-ela.bin', content.length);
    const id = started.body.id;
    await s.ana.browser.bytes('PUT', `/api/uploads/${id}/parts/0`, content.subarray(0, PART));

    // Ana herself cannot close it with a part missing.
    expect(await bind(app, s.ana)).toBe(true);
    const missing = await attempt(app, `SELECT app.finish_upload($1, sha256('x'), NULL)`, [id]);
    expect(missing).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
    await s.ana.browser.bytes('PUT', `/api/uploads/${id}/parts/1`, content.subarray(PART));

    // Marta edits the item too, but this upload, now complete, is not hers to touch.
    expect(await bind(app, s.marta)).toBe(true);
    const asMarta: [string, unknown[]][] = [
      [`SELECT * FROM app.attachment_parts WHERE attachment_id = $1`, [id]],
      [`INSERT INTO app.attachment_parts (attachment_id, n, size) VALUES ($1, 1, 10)`, [id]],
      [`UPDATE app.attachment_parts SET size = $2 WHERE attachment_id = $1`, [id, PART]],
      [`SELECT app.finish_upload($1, sha256('x'), NULL)`, [id]],
    ];
    for (const [text, values] of asMarta) {
      const result = await attempt(app, text, values);
      if (text.startsWith('SELECT app.')) expect(result.ok, text).toBe(false);
      else expect(result.ok && result.rowCount > 0, text).toBe(false);
    }
    await app.query('ROLLBACK');

    await s.ana.browser.post(`/api/uploads/${id}/finish`);
    await settled(s.ana, s.itemAna, id);
    // Finished: no more parts, and the antivirus does not get a second say.
    expect(await bind(app, s.ana)).toBe(true);
    const late = await attempt(
      app,
      `INSERT INTO app.attachment_parts (attachment_id, n, size) VALUES ($1, 1, 10)
       ON CONFLICT (attachment_id, n) DO UPDATE SET size = EXCLUDED.size`,
      [id],
    );
    expect(late.ok).toBe(false);
    const again = await attempt(app, `SELECT app.record_scan($1, 'infected')`, [id]);
    expect(again).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
    // Once finished, Marta sees the file, but its parts stay the sender's business.
    expect(await bind(app, s.marta)).toBe(true);
    const seen = await app.query(`SELECT 1 FROM app.attachments WHERE id = $1`, [id]);
    expect(seen.rowCount).toBe(1);
    const parts = await app.query(`SELECT 1 FROM app.attachment_parts WHERE attachment_id = $1`, [
      id,
    ]);
    expect(parts.rowCount).toBe(0);
    await app.query('ROLLBACK');

    // Not even the database's owner rewrites what a file was sent as, or adds to a closed upload.
    await expect(
      env.admin.query(`UPDATE app.attachments SET name = 'outro.bin' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'CB003' });
    await expect(
      env.admin.query(
        `UPDATE app.attachment_parts SET size = 10 WHERE attachment_id = $1 AND n = 1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: 'CB003' });
  });

  it('someone who may only look at an item attaches nothing and removes nothing', async () => {
    const sent = await upload(s.owner, s.itemNobody, 'para-olhar.txt', Buffer.from('ver'));
    await settled(s.owner, s.itemNobody, sent.id);
    await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
      itemScope: 'all',
    });
    expect((await download(s.nuno, sent.id)).status).toBe(200);
    expect((await s.nuno.browser.post(`/api/attachments/${sent.id}/trash`)).status).toBe(403);
    expect((await start(s.nuno, s.itemNobody, 'dele.txt', 3)).status).toBe(403);
    expect(await bind(app, s.nuno)).toBe(true);
    const tries: [string, unknown[]][] = [
      [`UPDATE app.attachments SET deleted_at = now() WHERE id = $1`, [sent.id]],
      [
        `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key)
         VALUES (gen_random_uuid(), $1, 'dele', 1, '', '\\x00')`,
        [s.itemNobody],
      ],
    ];
    for (const [text, values] of tries) {
      const result = await attempt(app, text, values);
      expect(result.ok && result.rowCount > 0, text).toBe(false);
    }
    await app.query('ROLLBACK');
  });

  it('the trash date is the database’s, and nothing is attached to an item in the trash', async () => {
    const sent = await upload(s.owner, s.itemNobody, 'datado.txt', Buffer.from('data'));
    await settled(s.owner, s.itemNobody, sent.id);
    expect(await bind(app, s.owner)).toBe(true);
    await app.query(`UPDATE app.attachments SET deleted_at = '2000-01-01' WHERE id = $1`, [
      sent.id,
    ]);
    const stored = await app.query<{ recent: boolean }>(
      `SELECT deleted_at > now() - interval '1 minute' AS recent FROM app.attachments WHERE id = $1`,
      [sent.id],
    );
    expect(stored.rows).toEqual([{ recent: true }]);
    await app.query(`UPDATE app.items SET deleted_at = now() WHERE id = $1`, [s.itemNobody]);
    const attached = await attempt(
      app,
      `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key)
       VALUES (gen_random_uuid(), $1, 'na-lixeira', 1, '', '\\x00')`,
      [s.itemNobody],
    );
    expect(attached).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
  });

  it('an employee cannot attach to, finish or read files of someone else’s item', async () => {
    const sent = await upload(s.owner, s.itemBruno, 'do-bruno.txt', Buffer.from('dele'));
    await settled(s.owner, s.itemBruno, sent.id);
    expect(await bind(app, s.ana)).toBe(true);
    const seen = await app.query('SELECT 1 FROM app.attachments WHERE id = $1', [sent.id]);
    expect(seen.rowCount).toBe(0);
    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key)
         VALUES (gen_random_uuid(), $1, 'intruso', 1, '', '\\x00')`,
        [s.itemBruno],
      ],
      [`UPDATE app.attachments SET deleted_at = now() WHERE id = $1`, [sent.id]],
      [`SELECT app.finish_upload($1, sha256('x'), NULL)`, [sent.id]],
      [`SELECT app.cancel_upload($1)`, [sent.id]],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(result.ok && result.rowCount > 0 && !text.startsWith('SELECT app.'), text).toBe(false);
      if (text.startsWith('SELECT app.')) expect(result.ok, text).toBe(false);
    }
    await app.query('ROLLBACK');
  });

  it('a part fits its place in the file, and only while the upload is open', async () => {
    const started = await start(s.ana, s.itemAna, 'partes.bin', PART + 10);
    expect(await bind(app, s.ana)).toBe(true);
    const tries: [number, number, boolean][] = [
      [0, PART, true],
      [1, 10, true],
      [1, 11, false],
      [2, 10, false],
      [0, 10, false],
    ];
    for (const [n, size, fine] of tries) {
      const result = await attempt(
        app,
        `INSERT INTO app.attachment_parts (attachment_id, n, size) VALUES ($1, $2, $3)
         ON CONFLICT (attachment_id, n) DO UPDATE SET size = EXCLUDED.size`,
        [started.body.id, n, size],
      );
      expect(result.ok, `${n}:${size}`).toBe(fine);
    }
    await app.query('ROLLBACK');
  });
});
