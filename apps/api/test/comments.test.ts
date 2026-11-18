import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Comments: read by whoever sees the item, written by whoever edits it, changed
 * only by their author with every earlier version kept, removed by the author
 * or a manager of the list, and then out of everyone's reach. By the API and
 * at the database.
 */

interface Comment {
  id: string;
  authorId: string;
  body: string;
  editedAt: string | null;
  removedAt: string | null;
  removedBy: string | null;
  versions: number;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const list = (person: Person, itemId: string) =>
  person.browser.get<Comment[] & ErrorBody>(`/api/items/${itemId}/comments`);
const write = (person: Person, itemId: string, body: string) =>
  person.browser.post<Comment & ErrorBody>(`/api/items/${itemId}/comments`, { body });
const edit = (person: Person, commentId: string, body: string) =>
  person.browser.patch<Comment & ErrorBody>(`/api/comments/${commentId}`, { body });
const remove = (person: Person, commentId: string) =>
  person.browser.delete<Comment & ErrorBody>(`/api/comments/${commentId}`);
const versions = (person: Person, commentId: string) =>
  person.browser.get<{ body: string }[] & ErrorBody>(`/api/comments/${commentId}/versions`);

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
  it('is written by whoever edits the item and read by whoever sees it, in order', async () => {
    const first = await write(s.ana, s.itemAna, 'Subi as fotos.');
    expect(first.body).toMatchObject({ authorId: s.ana.id, body: 'Subi as fotos.', versions: 0 });
    await write(s.marta, s.itemAna, 'Ótimo, pode publicar.');
    expect((await list(s.ana, s.itemAna)).body.map((one) => one.body)).toEqual([
      'Subi as fotos.',
      'Ótimo, pode publicar.',
    ]);
    const item = (
      await s.ana.browser.get<{ id: string; comments: number }[]>(`/api/lists/${s.tarefas}/items`)
    ).body.find((one) => one.id === s.itemAna);
    expect(item?.comments).toBe(2);
    // Bruno's item is not there for Ana: nor are its comments.
    await write(s.bruno, s.itemBruno, 'Só meu.');
    expect((await list(s.ana, s.itemBruno)).status).toBe(404);
    expect((await write(s.ana, s.itemBruno, 'Intrusa')).status).toBe(404);
    expect((await write(s.ana, s.itemAna, '   ')).status).toBe(400);
  });

  it('is changed only by its author, keeping every earlier version', async () => {
    const said = await write(s.ana, s.itemAna, 'Entrego amanhã.');
    expect((await edit(s.marta, said.body.id, 'Entrega hoje!')).status).toBe(403);
    const changed = await edit(s.ana, said.body.id, 'Entrego hoje à tarde.');
    expect(changed.body).toMatchObject({ body: 'Entrego hoje à tarde.', versions: 1 });
    expect(changed.body.editedAt).not.toBeNull();
    await edit(s.ana, said.body.id, 'Entregue.');
    expect((await versions(s.marta, said.body.id)).body.map((one) => one.body)).toEqual([
      'Entrego amanhã.',
      'Entrego hoje à tarde.',
    ]);
  });

  it('is removed by its author or a manager of the list, and then says nothing to anyone', async () => {
    const own = await write(s.ana, s.itemAna, 'Mandei errado.');
    await edit(s.ana, own.body.id, 'Mandei errado, desculpa.');
    const gone = await remove(s.ana, own.body.id);
    expect(gone.body).toMatchObject({ body: '', removedBy: s.ana.id, versions: 0 });
    expect((await versions(s.marta, own.body.id)).body).toEqual([]);
    expect((await edit(s.ana, own.body.id, 'Volta')).body.error.code).toBe('comment_removed');

    const hers = await write(s.ana, s.itemAna, 'Senha do painel: 1234');
    // Bruno does not see the item; Marta manages the space, so the list.
    expect((await remove(s.bruno, hers.body.id)).status).toBe(404);
    const moderated = await remove(s.marta, hers.body.id);
    expect(moderated.body).toMatchObject({ body: '', removedBy: s.marta.id });
    const seen = (await list(s.ana, s.itemAna)).body.find((one) => one.id === hers.body.id);
    expect(seen).toMatchObject({ body: '', removedBy: s.marta.id });
  });

  it('does not let a colleague remove what someone else wrote without managing the list', async () => {
    // Bruno edits his own item; the owner comments on it.
    const ownerSaid = await write(s.owner, s.itemBruno, 'Revisa o valor?');
    expect((await remove(s.bruno, ownerSaid.body.id)).status).toBe(403);
    expect((await edit(s.bruno, ownerSaid.body.id, 'Mudei')).status).toBe(403);
  });

  it('changes nothing while the item is in the trash', async () => {
    const item = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Comentado',
      })
    ).body.id;
    const said = await write(s.owner, item, 'Antes da lixeira.');
    expect((await s.owner.browser.post(`/api/items/${item}/trash`, {})).status).toBe(200);
    expect((await write(s.owner, item, 'Depois')).status).toBe(404);
    expect((await edit(s.owner, said.body.id, 'Mudou')).status).toBe(404);
    // Nor straight at the database.
    expect(await bind(app, s.owner)).toBe(true);
    for (const [text, values] of [
      [
        `INSERT INTO app.item_comments (id, item_id, body) VALUES (gen_random_uuid(), $1, 'x')`,
        [item],
      ],
      [`UPDATE app.item_comments SET body = 'Mudou' WHERE id = $1`, [said.body.id]],
      [`UPDATE app.item_comments SET deleted_at = now() WHERE id = $1`, [said.body.id]],
    ] as const) {
      expect(await attempt(app, text, [...values]), text).toMatchObject({
        ok: false,
        code: 'CB003',
      });
    }
    await app.query('ROLLBACK');
  });
});

describe('straight at the database', () => {
  it('holds the same rules for authors, managers and readers', async () => {
    const ana = await write(s.ana, s.itemAna, 'Da Ana');
    // A list Bruno only reads, with a comment in it.
    const o = s.owner.browser;
    const showcase = (
      await o.post<{ id: string }>('/api/lists', { spaceId: s.financeiro, name: 'Mural' })
    ).body.id;
    const shown = (await o.post<{ id: string }>(`/api/lists/${showcase}/items`, { title: 'Aviso' }))
      .body.id;
    const notice = await write(s.owner, shown, 'Leiam com atenção.');
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
    expect(
      await attempt(app, `SELECT body FROM app.item_comments WHERE id = $1`, [notice.body.id]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    // Reading is not writing.
    const posted = await attempt(
      app,
      `INSERT INTO app.item_comments (id, item_id, body) VALUES (gen_random_uuid(), $1, 'x')`,
      [shown],
    );
    expect(posted.ok).toBe(false);
    for (const text of [
      `UPDATE app.item_comments SET body = 'trocado' WHERE id = $1`,
      `UPDATE app.item_comments SET deleted_at = now() WHERE id = $1`,
    ]) {
      expect(await attempt(app, text, [notice.body.id]), text).toMatchObject({
        ok: true,
        rowCount: 0,
      });
    }
    // Ana's comment is on an item Bruno does not see.
    expect(
      await attempt(app, `SELECT 1 FROM app.item_comments WHERE id = $1`, [ana.body.id]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    expect((await attempt(app, `UPDATE app.item_comments SET body = 'x'`)).ok).toBe(true);
    expect((await attempt(app, `DELETE FROM app.item_comments`)).ok).toBe(false);
    await app.query('ROLLBACK');
    const kept = await env.admin.query(`SELECT body FROM app.item_comments WHERE id = ANY ($1)`, [
      [notice.body.id, ana.body.id],
    ]);
    expect(kept.rows.map((row: { body: string }) => row.body).sort()).toEqual([
      'Da Ana',
      'Leiam com atenção.',
    ]);

    // A manager of the list may remove someone else's comment, never rewrite it.
    expect(await bind(app, s.marta)).toBe(true);
    const rewrite = await attempt(
      app,
      `UPDATE app.item_comments SET body = 'outro' WHERE id = $1`,
      [ana.body.id],
    );
    expect(rewrite).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');
    // A colleague who edits the item but did not write the comment may do neither.
    const ownerSaid = await write(s.owner, s.itemBruno, 'Do Dono');
    expect(await bind(app, s.bruno)).toBe(true);
    for (const text of [
      `UPDATE app.item_comments SET body = 'outro' WHERE id = $1`,
      `UPDATE app.item_comments SET deleted_at = now() WHERE id = $1`,
    ]) {
      const tried = await attempt(app, text, [ownerSaid.body.id]);
      expect(tried.ok && tried.rowCount === 1, text).toBe(false);
    }
    await app.query('ROLLBACK');
  });

  it('stamps author and moments, keeps versions untouchable, and hides what was removed', async () => {
    const said = await write(s.bruno, s.itemBruno, 'Primeira versão');
    expect(await bind(app, s.bruno)).toBe(true);
    for (const text of [
      `UPDATE app.item_comments SET author_id = $2 WHERE id = $1`,
      `UPDATE app.item_comments SET deleted_by = $2 WHERE id = $1`,
    ]) {
      expect((await attempt(app, text, [said.body.id, s.owner.id])).ok, text).toBe(false);
    }
    const forged = await attempt(
      app,
      `INSERT INTO app.item_comments (id, item_id, body, deleted_at) VALUES (gen_random_uuid(), $1, 'x', now())`,
      [s.itemBruno],
    );
    expect(forged.ok).toBe(false);
    const edited = await attempt(
      app,
      `UPDATE app.item_comments SET body = 'Segunda versão' WHERE id = $1 RETURNING edited_at`,
      [said.body.id],
    );
    expect(edited.rows[0]?.edited_at).not.toBeNull();
    for (const text of [
      `INSERT INTO app.item_comment_versions (comment_id, body) VALUES ($1, 'falsa')`,
      `UPDATE app.item_comment_versions SET body = 'falsa' WHERE comment_id = $1`,
      `DELETE FROM app.item_comment_versions WHERE comment_id = $1`,
    ]) {
      expect((await attempt(app, text, [said.body.id])).ok, text).toBe(false);
    }
    const removed = await attempt(
      app,
      `UPDATE app.item_comments SET deleted_at = '2000-01-01' WHERE id = $1 RETURNING body, deleted_by, deleted_at > now() - interval '1 minute' AS recent`,
      [said.body.id],
    );
    expect(removed.rows[0]).toEqual({ body: '', deleted_by: s.bruno.id, recent: true });
    expect(
      await attempt(app, `SELECT 1 FROM app.item_comment_versions WHERE comment_id = $1`, [
        said.body.id,
      ]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    const back = await attempt(app, `UPDATE app.item_comments SET body = 'Voltou' WHERE id = $1`, [
      said.body.id,
    ]);
    expect(back).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('COMMIT');
    // Blank is refused by the database too.
    expect(await bind(app, s.bruno)).toBe(true);
    const blank = await attempt(
      app,
      `INSERT INTO app.item_comments (id, item_id, body) VALUES (gen_random_uuid(), $1, '  ')`,
      [s.itemBruno],
    );
    expect(blank).toMatchObject({ ok: false, code: '23514' });
    await app.query('ROLLBACK');

    // The owners of the server still have what it said, outside the application.
    const kept = await env.admin.query(
      `SELECT body FROM app.item_comment_versions WHERE comment_id = $1 ORDER BY id`,
      [said.body.id],
    );
    expect(kept.rows).toEqual([{ body: 'Primeira versão' }, { body: 'Segunda versão' }]);
    // Not even the owner of the database moves a comment, says who removed a live one,
    // writes one already removed, or rewrites a version.
    const live = await write(s.bruno, s.itemBruno, 'Ainda aqui');
    for (const [text, values] of [
      [`UPDATE app.item_comments SET item_id = $2 WHERE id = $1`, [live.body.id, s.itemAna]],
      [`UPDATE app.item_comments SET deleted_by = $2 WHERE id = $1`, [live.body.id, s.owner.id]],
      [
        `INSERT INTO app.item_comments (id, item_id, author_id, body, deleted_at, deleted_by)
         VALUES (gen_random_uuid(), $1, $2, '', now(), $2)`,
        [s.itemBruno, s.owner.id],
      ],
    ] as const) {
      await expect(env.admin.query(text, [...values]), text).rejects.toMatchObject({
        code: 'CB003',
      });
    }
    await expect(
      env.admin.query(`UPDATE app.item_comment_versions SET body = 'x' WHERE comment_id = $1`, [
        said.body.id,
      ]),
    ).rejects.toMatchObject({ code: 'CB001' });
  });
});
