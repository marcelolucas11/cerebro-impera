import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The checklist inside an item follows the item: read by whoever sees it,
 * changed by whoever edits it, frozen while it is in the trash. Who ticked a
 * line and when is the database's to write, and every change is in the
 * item's history.
 */

interface Check {
  id: string;
  itemId: string;
  text: string;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const lines = (person: Person, itemId: string) =>
  person.browser.get<Check[] & ErrorBody>(`/api/items/${itemId}/checklist`);
const add = (person: Person, itemId: string, text: string) =>
  person.browser.post<Check & ErrorBody>(`/api/items/${itemId}/checklist`, { text });
const change = (person: Person, checkId: string, body: Record<string, unknown>) =>
  person.browser.patch<Check & ErrorBody>(`/api/checklist/${checkId}`, body);
const newItem = async (title: string): Promise<string> =>
  (await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })).body.id;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('by the API', () => {
  it('adds lines in order, ticks and unticks them, and counts them on the item', async () => {
    const first = await add(s.ana, s.itemAna, '  Separar fotos  ');
    expect(first.body).toMatchObject({ text: 'Separar fotos', done: false, doneBy: null });
    const second = await add(s.ana, s.itemAna, 'Escrever legenda');
    const ticked = await change(s.ana, second.body.id, { done: true });
    expect(ticked.body).toMatchObject({ done: true, doneBy: s.ana.id });
    expect(ticked.body.doneAt).not.toBeNull();
    expect((await lines(s.ana, s.itemAna)).body.map((one) => one.text)).toEqual([
      'Separar fotos',
      'Escrever legenda',
    ]);
    const item = (
      await s.ana.browser.get<{ id: string; checks: { done: number; total: number } }[]>(
        `/api/lists/${s.tarefas}/items`,
      )
    ).body.find((one) => one.id === s.itemAna);
    expect(item?.checks).toEqual({ done: 1, total: 2 });
    const unticked = await change(s.ana, second.body.id, { done: false, text: 'Legenda curta' });
    expect(unticked.body).toMatchObject({ done: false, doneBy: null, doneAt: null });
    expect(unticked.body.text).toBe('Legenda curta');
    expect((await s.ana.browser.delete(`/api/checklist/${first.body.id}`)).status).toBe(200);
    expect((await lines(s.ana, s.itemAna)).body.map((one) => one.text)).toEqual(['Legenda curta']);
  });

  it('is read by whoever sees the item and changed only by whoever edits it', async () => {
    const line = await add(s.owner, s.itemBruno, 'Conferir valores');
    // Ana does not see Bruno's item: its checklist is not there for her.
    expect((await lines(s.ana, s.itemBruno)).status).toBe(404);
    expect((await add(s.ana, s.itemBruno, 'Intrusa')).status).toBe(404);
    expect((await change(s.ana, line.body.id, { done: true })).status).toBe(404);
    expect((await s.ana.browser.delete(`/api/checklist/${line.body.id}`)).status).toBe(404);
    expect((await lines(s.bruno, s.itemBruno)).body).toHaveLength(1);
  });

  it('refuses empty or long lines, and more than 100', async () => {
    const item = await newItem('Cheio');
    expect((await add(s.owner, item, '   ')).status).toBe(400);
    expect((await add(s.owner, item, 'x'.repeat(501))).status).toBe(400);
    await env.admin.query(
      `INSERT INTO app.item_checks (id, item_id, text, position, created_by)
       SELECT gen_random_uuid(), $1, 'Linha ' || n, n, $2 FROM generate_series(1, 100) n`,
      [item, s.owner.id],
    );
    expect((await add(s.owner, item, 'Mais uma')).body.error.code).toBe('too_many_checks');
    // The database holds the same limit.
    expect(await bind(app, s.owner)).toBe(true);
    const more = await attempt(
      app,
      `INSERT INTO app.item_checks (id, item_id, text, position) VALUES (gen_random_uuid(), $1, 'x', 101)`,
      [item],
    );
    expect(more).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
  });

  it('writes every change in the item’s history, with the text of the line', async () => {
    const item = await newItem('Com histórico');
    const line = await add(s.marta, item, 'Ligar para o cliente');
    await change(s.marta, line.body.id, { done: true });
    await change(s.marta, line.body.id, { text: 'Ligar e confirmar' });
    await change(s.marta, line.body.id, { done: false });
    await s.marta.browser.delete(`/api/checklist/${line.body.id}`);
    const story = await env.admin.query(
      `SELECT what, actor, old, new FROM app.item_changes
       WHERE item_id = $1 AND what LIKE 'check%' ORDER BY id`,
      [item],
    );
    expect(story.rows).toEqual([
      { what: 'check_added', actor: s.marta.id, old: null, new: 'Ligar para o cliente' },
      { what: 'check_done', actor: s.marta.id, old: null, new: 'Ligar para o cliente' },
      {
        what: 'check_renamed',
        actor: s.marta.id,
        old: 'Ligar para o cliente',
        new: 'Ligar e confirmar',
      },
      { what: 'check_undone', actor: s.marta.id, old: null, new: 'Ligar e confirmar' },
      { what: 'check_removed', actor: s.marta.id, old: 'Ligar e confirmar', new: null },
    ]);
  });

  it('freezes with the item in the trash, and goes with it when it is removed for good', async () => {
    const item = await newItem('Vai para a lixeira');
    const line = await add(s.owner, item, 'Ficou pela metade');
    expect((await s.owner.browser.post(`/api/items/${item}/trash`, {})).status).toBe(200);
    expect((await change(s.owner, line.body.id, { done: true })).status).toBe(404);
    expect((await add(s.owner, item, 'Nova')).status).toBe(404);
    // Only the owner of the database, with the protection off, can age an item in the trash.
    await env.admin.query('ALTER TABLE app.items DISABLE TRIGGER trash_guard');
    try {
      await env.admin.query(
        `UPDATE app.items SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [item],
      );
    } finally {
      await env.admin.query('ALTER TABLE app.items ENABLE TRIGGER trash_guard');
    }
    await env.admin.query(`SELECT app.purge_trash()`);
    const left = await env.admin.query(`SELECT 1 FROM app.item_checks WHERE item_id = $1`, [item]);
    expect(left.rowCount).toBe(0);
  });
});

describe('straight at the database', () => {
  it('only whoever edits the item changes its checklist', async () => {
    const line = await add(s.owner, s.itemBruno, 'Só do Bruno');
    // A list Bruno can only read.
    const o = s.owner.browser;
    const showcase = (
      await o.post<{ id: string }>('/api/lists', { spaceId: s.financeiro, name: 'Vitrine' })
    ).body.id;
    const shown = (await o.post<{ id: string }>(`/api/lists/${showcase}/items`, { title: 'Ver' }))
      .body.id;
    const shownLine = await add(s.owner, shown, 'Só olhar');
    expect(
      (
        await o.put('/api/grants', {
          userId: s.bruno.id,
          scopeType: 'list',
          scopeId: showcase,
          level: 'view',
          itemScope: 'all',
        })
      ).status,
    ).toBe(200);

    expect(await bind(app, s.bruno)).toBe(true);
    const read = await attempt(app, `SELECT text FROM app.item_checks WHERE id = $1`, [
      shownLine.body.id,
    ]);
    expect(read).toMatchObject({ ok: true, rowCount: 1 });
    for (const text of [
      `UPDATE app.item_checks SET done = true WHERE id = $1`,
      `DELETE FROM app.item_checks WHERE id = $1`,
    ]) {
      expect(await attempt(app, text, [shownLine.body.id]), text).toMatchObject({
        ok: true,
        rowCount: 0,
      });
    }
    // Statements that name no row are held to the same rule.
    expect((await attempt(app, `UPDATE app.item_checks SET done = true`)).ok).toBe(true);
    expect((await attempt(app, `DELETE FROM app.item_checks`)).ok).toBe(true);
    const still = await attempt(app, `SELECT done FROM app.item_checks WHERE id = $1`, [
      shownLine.body.id,
    ]);
    expect(still.rows).toEqual([{ done: false }]);
    const inserted = await attempt(
      app,
      `INSERT INTO app.item_checks (id, item_id, text, position) VALUES (gen_random_uuid(), $1, 'x', 9)`,
      [shown],
    );
    expect(inserted.ok).toBe(false);
    await app.query('ROLLBACK');

    // Ana, who does not see Bruno's item, neither reads nor writes its checklist.
    expect(await bind(app, s.ana)).toBe(true);
    const hidden = await attempt(app, `SELECT 1 FROM app.item_checks WHERE id = $1`, [
      line.body.id,
    ]);
    expect(hidden).toMatchObject({ ok: true, rowCount: 0 });
    const forged = await attempt(
      app,
      `INSERT INTO app.item_checks (id, item_id, text, position) VALUES (gen_random_uuid(), $1, 'x', 9)`,
      [s.itemBruno],
    );
    expect(forged.ok).toBe(false);
    await app.query('ROLLBACK');
  });

  it('stamps who ticked and when, keeps a line on its item, and freezes it in the trash', async () => {
    const line = await add(s.bruno, s.itemBruno, 'Carimbo');
    const other = await add(s.bruno, s.itemBruno, 'Outra');
    expect(await bind(app, s.bruno)).toBe(true);
    const ticked = await attempt(
      app,
      `UPDATE app.item_checks SET done = true WHERE id = $1 RETURNING done_by, done_at`,
      [line.body.id],
    );
    expect(ticked.rows[0]?.done_by).toBe(s.bruno.id);
    expect(ticked.rows[0]?.done_at).not.toBeNull();
    // Saying someone else ticked it, or when, is not the application's to do.
    for (const text of [
      `UPDATE app.item_checks SET done_by = $2 WHERE id = $1`,
      `UPDATE app.item_checks SET done_at = now() - interval '1 year' WHERE id = $1`,
      `UPDATE app.item_checks SET item_id = $2 WHERE id = $1`,
      `UPDATE app.item_checks SET created_by = $2 WHERE id = $1`,
    ]) {
      const forged = await attempt(app, text, [other.body.id, s.owner.id]);
      expect(forged.ok, text).toBe(false);
    }
    // Text that is only spaces at the ends is refused by the database too.
    const padded = await attempt(app, `UPDATE app.item_checks SET text = ' x ' WHERE id = $1`, [
      other.body.id,
    ]);
    expect(padded).toMatchObject({ ok: false, code: '23514' });
    // The history is the database's to write.
    const history = await attempt(
      app,
      `INSERT INTO app.item_changes (item_id, what, new) VALUES ($1, 'check_done', '"x"')`,
      [s.itemBruno],
    );
    expect(history.ok).toBe(false);
    await app.query('COMMIT');

    // Not even the owner of the database moves a line to another item or back-dates a tick.
    const elsewhere = await newItem('Outro item');
    await expect(
      env.admin.query(`UPDATE app.item_checks SET item_id = $2 WHERE id = $1`, [
        line.body.id,
        elsewhere,
      ]),
    ).rejects.toMatchObject({ code: 'CB003' });
    await env.admin.query(
      `UPDATE app.item_checks SET done_at = '2020-01-01', done_by = $2 WHERE id = $1`,
      [line.body.id, s.owner.id],
    );
    const stamped = await env.admin.query<{ done_by: string; year: number }>(
      `SELECT done_by, extract(year FROM done_at)::int AS year FROM app.item_checks WHERE id = $1`,
      [line.body.id],
    );
    expect(stamped.rows[0]).toMatchObject({ done_by: s.bruno.id });
    expect(stamped.rows[0]?.year).not.toBe(2020);

    // In the trash nothing about it changes, not even straight at the database.
    const item = await newItem('Congelado');
    const frozen = await add(s.owner, item, 'Parada');
    expect((await s.owner.browser.post(`/api/items/${item}/trash`, {})).status).toBe(200);
    expect(await bind(app, s.owner)).toBe(true);
    for (const text of [
      `UPDATE app.item_checks SET done = true WHERE id = $1`,
      `DELETE FROM app.item_checks WHERE id = $1`,
    ]) {
      expect(await attempt(app, text, [frozen.body.id]), text).toMatchObject({
        ok: false,
        code: 'CB003',
      });
    }
    await app.query('ROLLBACK');
  });
});
