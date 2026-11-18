import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Secret fields: kept sealed where the API cannot read them back, revealed one
 * at a time with a recent second factor, every reveal on the record, and never
 * shown in lists or in the history. First through the API, then at the database.
 */

interface ErrorBody {
  error: { code: string; details?: { problem?: string } };
}
interface Item {
  id: string;
  fields: Record<string, unknown>;
  secrets: string[];
}

const PASSWORD = '  cavalo-correto bateria grampo  '; // gitleaks:allow (senha fictícia de teste)

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let secret: string;
let note: string;

const put = (person: Person, item: string, value: string | null, field = secret) =>
  person.browser.put<{ set: boolean } & ErrorBody>(`/api/items/${item}/secrets/${field}`, {
    value,
  });
const reveal = (person: Person, item: string, field = secret) =>
  person.browser.post<{ value: string } & ErrorBody>(`/api/items/${item}/secrets/${field}/reveal`);
const itemsOf = async (person: Person, list: string): Promise<Item[]> =>
  (await person.browser.get<Item[]>(`/api/lists/${list}/items`)).body;
const reveals = async (item: string): Promise<number> =>
  (
    await env.admin.query(
      `SELECT 1 FROM audit.log WHERE action = 'secret.revealed' AND target_id = $1`,
      [item],
    )
  ).rowCount ?? 0;
const freshCode = (person: Person) =>
  env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [person.id]);

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const created = await s.owner.browser.post<{ id: string; config: unknown }>(
    `/api/lists/${s.tarefas}/fields`,
    { name: 'Senha do painel', kind: 'secret' },
  );
  expect(created.status).toBe(200);
  expect(created.body.config).toEqual({});
  secret = created.body.id;
  note = (
    await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Observação',
      kind: 'text',
    })
  ).body.id;
  // Revealing is a capability an owner hands out; Bruno is left without it.
  for (const person of [s.marta, s.ana, s.nuno]) {
    const granted = await s.owner.browser.put(`/api/users/${person.id}/capabilities`, {
      capabilities: ['secret_fields.reveal'],
    });
    expect(granted.status).toBe(200);
  }
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('a secret field', () => {
  it('keeps the value sealed and out of every list', async () => {
    expect((await put(s.marta, s.itemNobody, PASSWORD)).body).toEqual({ set: true });
    const listed = await s.marta.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`);
    const item = listed.body.find((candidate) => candidate.id === s.itemNobody);
    expect(item?.secrets).toEqual([secret]);
    expect(item?.fields).not.toHaveProperty(secret);
    expect(JSON.stringify(listed.body)).not.toContain('cavalo');
    // On disk, only noise.
    const stored = await env.admin.query<{ sealed: Buffer }>(
      `SELECT sealed FROM app.item_secrets WHERE item_id = $1`,
      [s.itemNobody],
    );
    expect(stored.rows[0]?.sealed.includes(Buffer.from('cavalo'))).toBe(false);
  });

  it('is revealed exactly as typed, with a recent code, and each reveal is on the record', async () => {
    await put(s.marta, s.itemNobody, PASSWORD);
    const before = await reveals(s.itemNobody);
    const shown = await reveal(s.marta, s.itemNobody);
    expect(shown.status).toBe(200);
    expect(shown.body.value).toBe(PASSWORD);
    expect(await reveals(s.itemNobody)).toBe(before + 1);
    const line = await env.admin.query<{ actor_user_id: string; metadata: { field_id: string } }>(
      `SELECT actor_user_id, metadata FROM audit.log
       WHERE action = 'secret.revealed' AND target_id = $1 ORDER BY seq DESC LIMIT 1`,
      [s.itemNobody],
    );
    expect(line.rows[0]).toEqual({ actor_user_id: s.marta.id, metadata: { field_id: secret } });

    // Not in a sensitive list, and still the code is asked again once it is old.
    await expireStepUp(env, s.marta);
    const stale = await reveal(s.marta, s.itemNobody);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('step_up_required');
    expect(await reveals(s.itemNobody)).toBe(before + 1);
    await freshCode(s.marta);
  });

  it('takes any text up to its limit, and nothing else', async () => {
    expect((await put(s.marta, s.itemNobody, '€'.repeat(2000))).status).toBe(200);
    expect((await reveal(s.marta, s.itemNobody)).body.value).toBe('€'.repeat(2000));
    for (const value of ['', 'x'.repeat(2001)]) {
      expect((await put(s.marta, s.itemNobody, value)).status).toBe(400);
    }
    const wrong = await s.marta.browser.put(`/api/items/${s.itemNobody}/secrets/${secret}`, {
      value: 12345,
    });
    expect(wrong.status).toBe(400);
    // A field that is not secret is not written this way.
    expect((await put(s.marta, s.itemNobody, 'texto', note)).body.error.code).toBe('invalid_field');
  });

  it('never travels with the ordinary values', async () => {
    const refused = await s.marta.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
      fields: { [secret]: PASSWORD },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details?.problem).toBe('kept_apart');
  });

  it('is revealed only by who holds the capability, even on their own item', async () => {
    expect((await put(s.bruno, s.itemBruno, 'do Bruno')).status).toBe(200);
    const refused = await reveal(s.bruno, s.itemBruno);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('forbidden');
    expect(await reveals(s.itemBruno)).toBe(0);
    // He can still replace or clear it, without seeing it.
    expect((await put(s.bruno, s.itemBruno, null)).body).toEqual({ set: false });
  });

  it('follows the item: who sees it reveals, who edits it changes, others get nothing', async () => {
    expect((await put(s.ana, s.itemAna, 'da Ana')).status).toBe(200);
    expect((await reveal(s.ana, s.itemAna)).body.value).toBe('da Ana');
    for (const person of [s.bruno, s.nuno]) {
      // Bruno is stopped before anything is looked up: he may not reveal at all.
      expect((await reveal(person, s.itemAna)).status).toBe(person === s.bruno ? 403 : 404);
      expect((await put(person, s.itemAna, 'troca')).status).toBe(404);
      const theirs = await person.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`);
      // Bruno opens the list and does not find it there; Nuno cannot open the list at all.
      if (person === s.bruno) expect(theirs.body.map((item) => item.id)).not.toContain(s.itemAna);
      else expect(theirs.status).toBe(404);
    }
    // Someone who may only look: reveals, but does not change.
    await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
      itemScope: 'all',
    });
    expect((await reveal(s.nuno, s.itemAna)).body.value).toBe('da Ana');
    expect((await put(s.nuno, s.itemAna, 'troca')).status).toBe(403);
    expect((await put(s.nuno, s.itemAna, null)).status).toBe(403);
    expect((await reveal(s.ana, s.itemAna)).body.value).toBe('da Ana');
  });

  it('tells the history that it changed, never what it was', async () => {
    await put(s.marta, s.itemNobody, 'primeira');
    await put(s.marta, s.itemNobody, 'segunda');
    await put(s.marta, s.itemNobody, null);
    const history = await s.marta.browser.get<
      { what: string; fieldId: string; old: unknown; new: unknown }[]
    >(`/api/items/${s.itemNobody}/history`);
    const lines = history.body.filter((line) => line.fieldId === secret).slice(0, 3);
    expect(lines.map(({ old, new: after }) => [old, after])).toEqual([
      [{ secret: true }, null],
      [{ secret: true }, { secret: true }],
      [{ secret: true }, { secret: true }],
    ]);
    expect(JSON.stringify(history.body)).not.toMatch(/primeira|segunda|cavalo/);
    expect((await reveal(s.marta, s.itemNobody)).status).toBe(404);
    const item = (await itemsOf(s.marta, s.tarefas)).find((one) => one.id === s.itemNobody);
    expect(item?.secrets).toEqual([]);
  });

  it('stays behind when the item changes list, and comes back with it', async () => {
    await put(s.marta, s.itemNobody, 'fica aqui');
    const moved = await s.marta.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: s.perfis,
    });
    expect(moved.body.secrets).toEqual([]);
    expect((await reveal(s.marta, s.itemNobody)).status).toBe(400);
    const back = await s.marta.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: s.tarefas,
    });
    expect(back.body.secrets).toEqual([secret]);
    expect((await reveal(s.marta, s.itemNobody)).body.value).toBe('fica aqui');
  });

  it('is out of reach while the item is in the trash or the field is archived', async () => {
    await put(s.marta, s.itemNobody, 'guardada');
    await s.marta.browser.post(`/api/items/${s.itemNobody}/trash`);
    expect((await reveal(s.marta, s.itemNobody)).status).toBe(404);
    expect((await put(s.marta, s.itemNobody, 'outra')).status).toBe(404);
    await s.marta.browser.post(`/api/items/${s.itemNobody}/restore`);

    await s.owner.browser.patch(`/api/fields/${secret}`, { archived: true });
    expect((await reveal(s.marta, s.itemNobody)).status).toBe(400);
    const hidden = (await itemsOf(s.marta, s.tarefas)).find((one) => one.id === s.itemNobody);
    expect(hidden?.secrets).toEqual([]);
    await s.owner.browser.patch(`/api/fields/${secret}`, { archived: false });
    expect((await reveal(s.marta, s.itemNobody)).body.value).toBe('guardada');
  });

  it('cannot be read on another item: a sealed value moved between rows does not open', async () => {
    await put(s.marta, s.itemNobody, 'deste item');
    await put(s.ana, s.itemAna, 'daquele item');
    await env.admin.query(
      `UPDATE app.item_secrets SET sealed = (
         SELECT sealed FROM app.item_secrets WHERE item_id = $1 AND field_id = $3)
       WHERE item_id = $2 AND field_id = $3`,
      [s.itemNobody, s.itemAna, secret],
    );
    const swapped = await reveal(s.ana, s.itemAna);
    expect(swapped.status).toBe(500);
    expect(JSON.stringify(swapped.body)).not.toContain('deste item');
  });
});

describe('who changed it last', () => {
  it('is written by the database, whoever sends the request', async () => {
    await put(s.ana, s.itemAna, 'dela');
    await put(s.marta, s.itemAna, 'trocada pela gestora');
    const row = await env.admin.query<{ updated_by: string }>(
      `SELECT updated_by FROM app.item_secrets WHERE item_id = $1 AND field_id = $2`,
      [s.itemAna, secret],
    );
    expect(row.rows[0]?.updated_by).toBe(s.marta.id);
  });
});

describe('straight at the database', () => {
  it('the sealed value cannot be read, only revealed, and revealing is always recorded', async () => {
    await put(s.marta, s.itemNobody, 'no banco');
    expect(await bind(app, s.marta)).toBe(true);
    const direct = await attempt(app, `SELECT sealed FROM app.item_secrets WHERE item_id = $1`, [
      s.itemNobody,
    ]);
    expect(direct).toMatchObject({ ok: false, code: '42501' });
    const whole = await attempt(app, `SELECT * FROM app.item_secrets`);
    expect(whole).toMatchObject({ ok: false, code: '42501' });
    const exists = await attempt(
      app,
      `SELECT item_id, field_id FROM app.item_secrets WHERE item_id = $1`,
      [s.itemNobody],
    );
    expect(exists.rowCount).toBe(1);
    const before = await reveals(s.itemNobody);
    const revealed = await attempt(app, `SELECT app.reveal_secret($1, $2) AS sealed`, [
      s.itemNobody,
      secret,
    ]);
    expect(revealed.ok).toBe(true);
    await app.query('COMMIT');
    expect(await reveals(s.itemNobody)).toBe(before + 1);
  });

  it('nobody reveals without a recent code, or what they do not see', async () => {
    await put(s.ana, s.itemAna, 'só da Ana');
    await expireStepUp(env, s.marta);
    expect(await bind(app, s.marta)).toBe(true);
    const stale = await attempt(app, `SELECT app.reveal_secret($1, $2)`, [s.itemAna, secret]);
    expect(stale).toMatchObject({ ok: false, code: 'CB002' });
    await app.query('ROLLBACK');
    await freshCode(s.marta);

    expect(await bind(app, s.bruno)).toBe(true);
    const notHis = await attempt(app, `SELECT app.reveal_secret($1, $2)`, [s.itemAna, secret]);
    expect(notHis).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    // Ana may reveal secrets, but not on an item she does not see.
    expect(await bind(app, s.ana)).toBe(true);
    const notHers = await attempt(app, `SELECT app.reveal_secret($1, $2)`, [s.itemBruno, secret]);
    expect(notHers).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    // His own item, but no capability to reveal.
    await put(s.bruno, s.itemBruno, 'do Bruno');
    expect(await bind(app, s.bruno)).toBe(true);
    const noCapability = await attempt(app, `SELECT app.reveal_secret($1, $2)`, [
      s.itemBruno,
      secret,
    ]);
    expect(noCapability).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    // In the trash, not even its own editor.
    await s.ana.browser.post(`/api/items/${s.itemAna}/trash`);
    expect(await bind(app, s.ana)).toBe(true);
    const trashed = await attempt(app, `SELECT app.reveal_secret($1, $2)`, [s.itemAna, secret]);
    expect(trashed).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');
    await s.ana.browser.post(`/api/items/${s.itemAna}/restore`);
  });

  it('a secret goes only into a secret field, stays where it is, and only by who edits', async () => {
    const sealed = Buffer.alloc(40, 1);
    expect(await bind(app, s.marta)).toBe(true);
    const wrongField = await attempt(
      app,
      `INSERT INTO app.item_secrets (item_id, field_id, sealed) VALUES ($1, $2, $3)`,
      [s.itemBruno, note, sealed],
    );
    expect(wrongField).toMatchObject({ ok: false, code: '23514' });
    const asValue = await attempt(
      app,
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '"x"')`,
      [s.itemBruno, secret],
    );
    expect(asValue).toMatchObject({ ok: false, code: '23514' });
    const moved = await attempt(app, `UPDATE app.item_secrets SET item_id = $1`, [s.itemBruno]);
    expect(moved).toMatchObject({ ok: false, code: '42501' });
    const author = await attempt(app, `UPDATE app.item_secrets SET updated_by = $1`, [s.ana.id]);
    expect(author).toMatchObject({ ok: false, code: '42501' });
    await app.query('ROLLBACK');

    // Bruno edits his own items only: Ana's secret is beyond him.
    expect(await bind(app, s.bruno)).toBe(true);
    const others = await attempt(
      app,
      `UPDATE app.item_secrets SET sealed = $2 WHERE item_id = $1`,
      [s.itemAna, sealed],
    );
    expect(others.ok && others.rowCount > 0).toBe(false);
    const gone = await attempt(app, `DELETE FROM app.item_secrets WHERE item_id = $1`, [s.itemAna]);
    expect(gone.ok && gone.rowCount > 0).toBe(false);
    const planted = await attempt(
      app,
      `INSERT INTO app.item_secrets (item_id, field_id, sealed) VALUES ($1, $2, $3)
       ON CONFLICT (item_id, field_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
      [s.itemAna, secret, sealed],
    );
    expect(planted.ok).toBe(false);
    await app.query('ROLLBACK');

    // Someone who may only look changes nothing either, not even where there is no value yet.
    await put(s.bruno, s.itemBruno, null);
    expect(await bind(app, s.nuno)).toBe(true);
    const asViewer: [string, unknown[]][] = [
      [`UPDATE app.item_secrets SET sealed = $2 WHERE item_id = $1`, [s.itemAna, sealed]],
      [`DELETE FROM app.item_secrets WHERE item_id = $1`, [s.itemAna]],
      [
        `INSERT INTO app.item_secrets (item_id, field_id, sealed) VALUES ($1, $3, $2)`,
        [s.itemBruno, sealed, secret],
      ],
    ];
    for (const [text, values] of asViewer) {
      const result = await attempt(app, text, values);
      expect(result.ok && result.rowCount > 0, text).toBe(false);
    }
    await app.query('ROLLBACK');

    // Nothing changes on an item in the trash, nor in an archived field.
    await s.ana.browser.post(`/api/items/${s.itemAna}/trash`);
    expect(await bind(app, s.ana)).toBe(true);
    const inTrash = await attempt(
      app,
      `UPDATE app.item_secrets SET sealed = $2 WHERE item_id = $1`,
      [s.itemAna, sealed],
    );
    expect(inTrash).toMatchObject({ ok: false, code: 'CB003' });
    const clearedInTrash = await attempt(app, `DELETE FROM app.item_secrets WHERE item_id = $1`, [
      s.itemAna,
    ]);
    expect(clearedInTrash).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
    await s.ana.browser.post(`/api/items/${s.itemAna}/restore`);
    await s.owner.browser.patch(`/api/fields/${secret}`, { archived: true });
    expect(await bind(app, s.marta)).toBe(true);
    const archived = await attempt(
      app,
      `INSERT INTO app.item_secrets (item_id, field_id, sealed) VALUES ($1, $2, $3)`,
      [s.itemBruno, secret, sealed],
    );
    expect(archived.ok).toBe(false);
    await app.query('ROLLBACK');
    await s.owner.browser.patch(`/api/fields/${secret}`, { archived: false });
    expect((await reveal(s.ana, s.itemAna)).body.value).toBe('só da Ana');
  });
});
