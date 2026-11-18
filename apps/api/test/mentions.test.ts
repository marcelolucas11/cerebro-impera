import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Mentions and the people of an item. Only someone who can see the item is
 * mentioned on it, only by the comment's author; and the names an item shows
 * are those of people who see it or took part in its comments, to whoever
 * sees it, and to nobody else.
 */

interface Comment {
  id: string;
  mentions: string[];
}
interface ItemPerson {
  id: string;
  name: string;
  seesItem: boolean;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const write = (person: Person, itemId: string, body: string, mentions?: string[]) =>
  person.browser.post<Comment & ErrorBody>(`/api/items/${itemId}/comments`, {
    body,
    ...(mentions === undefined ? {} : { mentions }),
  });
const people = (person: Person, itemId: string) =>
  person.browser.get<ItemPerson[] & ErrorBody>(`/api/items/${itemId}/people`);
const commentsOn = async (itemId: string) =>
  (
    await env.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.item_comments WHERE item_id = $1`,
      [itemId],
    )
  ).rows[0]?.n;

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
  it('names, to whoever sees the item, the people who see it', async () => {
    const seen = (await people(s.ana, s.itemAna)).body;
    expect(
      seen
        .filter((one) => one.seesItem)
        .map((one) => one.id)
        .sort(),
    ).toEqual([s.owner.id, s.marta.id, s.ana.id].sort());
    // Nobody who neither sees it nor took part is named.
    expect(seen.map((one) => one.id)).not.toContain(s.bruno.id);
    expect(seen.map((one) => one.id)).not.toContain(s.nuno.id);
    // Bruno does not see Ana's item: he learns nothing about who does.
    expect((await people(s.bruno, s.itemAna)).status).toBe(404);
  });

  it('follows the nearest grant: no access on the list wins over managing the space', async () => {
    await env.admin.query(
      `INSERT INTO app.access_grants (user_id, list_id, level, item_scope, granted_by)
       VALUES ($1, $2, 'none', 'all', $3)`,
      [s.marta.id, s.tarefas, s.owner.id],
    );
    try {
      const seen = (await people(s.owner, s.itemAna)).body;
      expect(seen.find((one) => one.id === s.marta.id)?.seesItem ?? false).toBe(false);
      expect((await write(s.owner, s.itemAna, 'Marta?', [s.marta.id])).body.error.code).toBe(
        'cannot_mention',
      );
    } finally {
      await env.admin.query(`DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2`, [
        s.marta.id,
        s.tarefas,
      ]);
    }
  });

  it('mentions only people who see the item, all or nothing', async () => {
    const made = await write(s.ana, s.itemAna, '@Marta, revisa?', [s.marta.id]);
    expect(made.body.mentions).toEqual([s.marta.id]);
    const before = await commentsOn(s.itemAna);
    const refused = await write(s.ana, s.itemAna, '@Bruno, olha isso', [s.marta.id, s.bruno.id]);
    expect(refused.body.error.code).toBe('cannot_mention');
    expect(await commentsOn(s.itemAna)).toBe(before);
    // Handed the item, Bruno sees it, and can be mentioned on it.
    await s.owner.browser.put(`/api/items/${s.itemAna}/assignees`, {
      userIds: [s.ana.id, s.bruno.id],
    });
    expect((await write(s.ana, s.itemAna, '@Bruno, agora sim', [s.bruno.id])).status).toBe(200);
    await s.owner.browser.put(`/api/items/${s.itemAna}/assignees`, { userIds: [s.ana.id] });
  });

  it('keeps mentions made, adds those of an edit, and hides them once the comment is removed', async () => {
    const made = await write(s.marta, s.itemAna, 'Ana, confere', [s.ana.id]);
    const edited = await s.marta.browser.patch<Comment>(`/api/comments/${made.body.id}`, {
      body: 'Ana e Dona, confiram',
      mentions: [s.owner.id],
    });
    expect([...edited.body.mentions].sort()).toEqual([s.ana.id, s.owner.id].sort());
    const removed = await s.marta.browser.delete<Comment>(`/api/comments/${made.body.id}`);
    expect(removed.body.mentions).toEqual([]);
  });

  it('keeps the names of people who took part, even after they stop seeing the item', async () => {
    const item = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Conversa antiga',
      })
    ).body.id;
    await s.owner.browser.put(`/api/items/${item}/assignees`, { userIds: [s.bruno.id] });
    await write(s.bruno, item, 'Comecei.');
    await s.owner.browser.put(`/api/items/${item}/assignees`, { userIds: [] });
    const named = (await people(s.owner, item)).body.find((one) => one.id === s.bruno.id);
    expect(named).toMatchObject({ name: 'Bruno Lima', seesItem: false });
    expect((await write(s.owner, item, 'Bruno?', [s.bruno.id])).body.error.code).toBe(
      'cannot_mention',
    );
  });
});

describe('straight at the database', () => {
  it('mentions only people who see the item, only by the author, never changed', async () => {
    const hers = await write(s.ana, s.itemAna, 'Da Ana');
    expect(await bind(app, s.ana)).toBe(true);
    const outsider = await attempt(
      app,
      `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`,
      [hers.body.id, s.bruno.id],
    );
    expect(outsider).toMatchObject({ ok: false, code: 'CB003' });
    expect(
      await attempt(app, `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`, [
        hers.body.id,
        s.marta.id,
      ]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    for (const text of [
      `UPDATE app.comment_mentions SET user_id = $2 WHERE comment_id = $1`,
      `DELETE FROM app.comment_mentions WHERE comment_id = $1`,
    ]) {
      expect((await attempt(app, text, [hers.body.id, s.owner.id])).ok, text).toBe(false);
    }
    await app.query('COMMIT');

    // Marta sees the item but did not write the comment.
    expect(await bind(app, s.marta)).toBe(true);
    const notHers = await attempt(
      app,
      `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`,
      [hers.body.id, s.owner.id],
    );
    expect(notHers.ok).toBe(false);
    await app.query('ROLLBACK');
    // Not even the owner of the database rewrites who was mentioned.
    await expect(
      env.admin.query(`UPDATE app.comment_mentions SET user_id = $2 WHERE comment_id = $1`, [
        hers.body.id,
        s.owner.id,
      ]),
    ).rejects.toMatchObject({ code: 'CB001' });
  });

  it('mentions nobody in a removed comment or on an item in the trash, and at most 20', async () => {
    const gone = await write(s.ana, s.itemAna, 'Vou apagar');
    await s.ana.browser.delete(`/api/comments/${gone.body.id}`);
    const item = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Muita gente',
      })
    ).body.id;
    const crowded = await write(s.owner, item, 'Todo mundo');
    const binned = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Lixo',
      })
    ).body.id;
    const inBin = await write(s.owner, binned, 'Antes da lixeira');
    await s.owner.browser.post(`/api/items/${binned}/trash`, {});

    // Who a removed comment mentioned is out of reach too.
    const named = await write(s.ana, s.itemAna, 'Marta, olha', [s.marta.id]);
    await s.ana.browser.delete(`/api/comments/${named.body.id}`);
    expect(await bind(app, s.ana)).toBe(true);
    expect(
      await attempt(app, `SELECT 1 FROM app.comment_mentions WHERE comment_id = $1`, [
        named.body.id,
      ]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    expect(
      await attempt(app, `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`, [
        gone.body.id,
        s.marta.id,
      ]),
    ).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
    expect(await bind(app, s.owner)).toBe(true);
    expect(
      await attempt(app, `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`, [
        inBin.body.id,
        s.marta.id,
      ]),
    ).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');

    // Twenty owners, who see everything, and a twenty-first.
    const owners = await env.admin.query<{ id: string }>(
      `INSERT INTO app.users (email, name, role, status)
       SELECT 'dono' || n || '@exemplo.test', 'Dono ' || n, 'owner', 'active'
       FROM generate_series(1, 21) n RETURNING id`,
    );
    const ids = owners.rows.map((row) => row.id);
    expect(await bind(app, s.owner)).toBe(true);
    const twenty = await attempt(
      app,
      `INSERT INTO app.comment_mentions (comment_id, user_id) SELECT $1, unnest($2::uuid[])`,
      [crowded.body.id, ids.slice(0, 20)],
    );
    expect(twenty).toMatchObject({ ok: true, rowCount: 20 });
    const more = await attempt(
      app,
      `INSERT INTO app.comment_mentions (comment_id, user_id) VALUES ($1, $2)`,
      [crowded.body.id, ids[20]],
    );
    expect(more).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
  });

  it('names nobody to someone who does not see the item, and a suspended account sees nothing', async () => {
    expect(await bind(app, s.bruno)).toBe(true);
    const names = await attempt(app, `SELECT id FROM app.item_people($1)`, [s.itemAna]);
    expect(names).toMatchObject({ ok: true, rowCount: 0 });
    await app.query('ROLLBACK');
    await env.admin.query(`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.marta.id]);
    try {
      expect(await bind(app, s.owner)).toBe(true);
      const seeing = await attempt(app, `SELECT id FROM app.item_people($1) WHERE sees_item`, [
        s.itemAna,
      ]);
      expect(seeing.rows.map((row) => row.id)).not.toContain(s.marta.id);
      await app.query('ROLLBACK');
    } finally {
      await env.admin.query(`UPDATE app.users SET status = 'active' WHERE id = $1`, [s.marta.id]);
    }
  });
});
