import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Notifications are written by the database on every path, reach only people
 * who see the item and never whoever caused them, are read only by their
 * recipient while the item is still theirs to see, and only "read" changes.
 * Also: many items to the trash in a short time alert the owners (D44).
 */

interface Notice {
  id: number;
  kind: string;
  itemId: string;
  itemTitle: string;
  actorName: string | null;
  dueOn: string | null;
  readAt: string | null;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let doneStage = '';

const inbox = async (person: Person): Promise<Notice[]> =>
  (await person.browser.get<Notice[]>('/api/notifications')).body;
const unread = async (person: Person): Promise<number> =>
  (await person.browser.get<{ unread: number }>('/api/notifications/unread')).body.unread;
const about = async (person: Person, itemId: string): Promise<string[]> =>
  (await inbox(person)).filter((one) => one.itemId === itemId).map((one) => one.kind);
const newItem = async (title: string, by: Person = s.owner): Promise<string> =>
  (await by.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })).body.id;
const handTo = (itemId: string, userIds: string[]) =>
  s.owner.browser.put(`/api/items/${itemId}/assignees`, { userIds });
const remindDue = async (): Promise<number> =>
  (await app.query<{ made: number }>('SELECT app.notify_due() AS made')).rows[0]?.made ?? 0;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const stages = (
    await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
  doneStage = stages.find((one) => one.kind === 'done')?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('what notifies whom', () => {
  it('tells someone an item was handed to them, never whoever handed it or took it', async () => {
    const id = await newItem('Revisar contrato');
    await handTo(id, [s.ana.id]);
    const got = (await inbox(s.ana)).find((one) => one.itemId === id);
    expect(got).toMatchObject({
      kind: 'assigned',
      itemTitle: 'Revisar contrato',
      actorName: 'Dona Primeira',
    });
    expect(await about(s.owner, id)).toEqual([]);
    // An item Ana creates is hers already: nothing to tell her.
    const own = await newItem('Meu rascunho', s.ana);
    expect(await about(s.ana, own)).toEqual([]);
  });

  it('tells whoever an item is with of a comment, or its creator when it is with nobody', async () => {
    await s.owner.browser.post(`/api/items/${s.itemAna}/comments`, { body: 'Como está?' });
    expect(await about(s.ana, s.itemAna)).toContain('commented');
    expect(await about(s.owner, s.itemAna)).not.toContain('commented');
    await s.marta.browser.post(`/api/items/${s.itemNobody}/comments`, { body: 'Alguém?' });
    expect(await about(s.owner, s.itemNobody)).toEqual(['commented']);
  });

  it('tells someone they were mentioned, instead of only of the comment', async () => {
    const said = await s.marta.browser.post<{ id: string }>(`/api/items/${s.itemAna}/comments`, {
      body: '@Ana Souza, fecha hoje?',
      mentions: [s.ana.id],
    });
    const forThis = (await inbox(s.ana)).filter(
      (one) => (one as unknown as { commentId: string }).commentId === said.body.id,
    );
    expect(forThis.map((one) => one.kind)).toEqual(['mentioned']);
  });

  it('reminds of what is due today or late, once, and not of what is finished or thrown away', async () => {
    const today = await newItem('Vence hoje');
    const late = await newItem('Atrasado');
    const finished = await newItem('Já feito');
    const binned = await newItem('Na lixeira');
    for (const id of [today, late, finished, binned]) await handTo(id, [s.ana.id]);
    await s.owner.browser.patch(`/api/items/${today}`, { dueDate: '2000-01-01' });
    await env.admin.query(`UPDATE app.items SET due_date = current_date WHERE id = $1`, [today]);
    await env.admin.query(`UPDATE app.items SET due_date = current_date - 3 WHERE id = ANY ($1)`, [
      [late, finished, binned],
    ]);
    await s.owner.browser.patch(`/api/items/${finished}`, { stageId: doneStage });
    await s.owner.browser.post(`/api/items/${binned}/trash`, {});
    expect(await remindDue()).toBeGreaterThanOrEqual(2);
    expect(await about(s.ana, today)).toContain('due_today');
    expect(await about(s.ana, late)).toContain('overdue');
    expect(await about(s.ana, finished)).not.toContain('overdue');
    const forBinned = await env.admin.query(
      `SELECT 1 FROM app.notifications WHERE item_id = $1 AND kind = 'overdue'`,
      [binned],
    );
    expect(forBinned.rowCount).toBe(0);
    expect(await remindDue()).toBe(0);
  });

  it('never tells anything to someone who cannot see the item', async () => {
    // Nuno has no access to the list; made an assignee behind the application's back.
    const id = await newItem('Fora do alcance');
    await env.admin.query(
      `INSERT INTO app.item_assignees (item_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
      [id, s.nuno.id, s.owner.id],
    );
    await env.admin.query(`UPDATE app.items SET due_date = current_date WHERE id = $1`, [id]);
    await s.owner.browser.post(`/api/items/${id}/comments`, { body: 'Nuno?' });
    await remindDue();
    const told = await env.admin.query(`SELECT kind FROM app.notifications WHERE user_id = $1`, [
      s.nuno.id,
    ]);
    expect(told.rows).toEqual([]);
  });
});

describe('who reads them', () => {
  it('shows them only while the recipient sees the item, and marks them read', async () => {
    const id = await newItem('Vai e volta');
    await handTo(id, [s.bruno.id]);
    expect(await about(s.bruno, id)).toEqual(['assigned']);
    const before = await unread(s.bruno);
    await handTo(id, []);
    // No longer his item: the notification is not shown, nor counted.
    expect(await about(s.bruno, id)).toEqual([]);
    expect(await unread(s.bruno)).toBe(before - 1);

    const mine = await inbox(s.ana);
    const first = mine[0];
    expect(first).toBeDefined();
    const one = await s.ana.browser.post<{ read: number }>('/api/notifications/read', {
      ids: [first?.id],
    });
    expect(one.body.read).toBe(1);
    // Bruno cannot mark Ana's.
    const second = mine[1]?.id;
    expect(
      (await s.bruno.browser.post<{ read: number }>('/api/notifications/read', { ids: [second] }))
        .body.read,
    ).toBe(0);
    await s.ana.browser.post('/api/notifications/read', {});
    expect(await unread(s.ana)).toBe(0);
  });
});

describe('straight at the database', () => {
  it('lets each person read and mark only their own, and change nothing else', async () => {
    const theirs = await env.admin.query<{ id: string }>(
      `SELECT id::text FROM app.notifications WHERE user_id = $1 LIMIT 1`,
      [s.ana.id],
    );
    const anaNotice = theirs.rows[0]?.id;
    expect(await bind(app, s.bruno)).toBe(true);
    expect(
      await attempt(app, `SELECT 1 FROM app.notifications WHERE id = $1`, [anaNotice]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    // A statement that names no row touches only his own: Ana's stay read.
    expect((await attempt(app, `UPDATE app.notifications SET read_at = NULL`)).ok).toBe(true);
    await app.query('COMMIT');
    const stillRead = await env.admin.query(
      `SELECT 1 FROM app.notifications WHERE user_id = $1 AND read_at IS NULL`,
      [s.ana.id],
    );
    expect(stillRead.rowCount).toBe(0);
    expect(await bind(app, s.bruno)).toBe(true);
    expect(
      await attempt(app, `UPDATE app.notifications SET read_at = NULL WHERE id = $1`, [anaNotice]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    const forged = await attempt(
      app,
      `INSERT INTO app.notifications (user_id, kind, item_id) VALUES ($1, 'assigned', $2)`,
      [s.bruno.id, s.itemBruno],
    );
    expect(forged.ok).toBe(false);
    expect((await attempt(app, `DELETE FROM app.notifications`)).ok).toBe(false);
    await app.query('ROLLBACK');

    expect(await bind(app, s.ana)).toBe(true);
    const unreadAgain = await attempt(
      app,
      `UPDATE app.notifications SET read_at = NULL WHERE id = $1 RETURNING read_at`,
      [anaNotice],
    );
    expect(unreadAgain).toMatchObject({ ok: true, rowCount: 1 });
    const backdated = await attempt(
      app,
      `UPDATE app.notifications SET read_at = '2000-01-01' WHERE id = $1
       RETURNING read_at > now() - interval '1 minute' AS recent`,
      [anaNotice],
    );
    expect(backdated.rows[0]).toEqual({ recent: true });
    await app.query('COMMIT');
    // Not even the owner of the database rewrites what one says.
    await expect(
      env.admin.query(`UPDATE app.notifications SET kind = 'mentioned' WHERE id = $1`, [anaNotice]),
    ).rejects.toMatchObject({ code: 'CB003' });
  });

  it('alerts the owners when one person sends many items to the trash in a short time', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 11; n += 1) ids.push(await newItem(`Descarte ${String(n)}`));
    const alerts = async (): Promise<number> =>
      (
        await env.admin.query(
          `SELECT 1 FROM app.security_alerts WHERE kind = 'trash_volume' AND actor_user_id = $1`,
          [s.marta.id],
        )
      ).rowCount ?? 0;
    // One at a time, each in its own request: no bulk capability needed, still counted.
    for (const id of ids.slice(0, 9)) {
      expect((await s.marta.browser.post(`/api/items/${id}/trash`, {})).status).toBe(200);
    }
    expect(await alerts()).toBe(0);
    await s.marta.browser.post(`/api/items/${ids[9] ?? ''}/trash`, {});
    expect(await alerts()).toBe(1);
    await s.marta.browser.post(`/api/items/${ids[10] ?? ''}/trash`, {});
    expect(await alerts()).toBe(1);
  });
});
