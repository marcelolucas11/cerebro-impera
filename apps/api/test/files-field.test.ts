import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * A field that names files of the item. It can name only the item's own
 * attachments, finished and not in the trash, by any path; what it named
 * before may stay; moving the item keeps what is still attached.
 */

interface ErrorBody {
  error: { code: string; details?: { problem?: string } };
}
interface Item {
  id: string;
  fields: Record<string, unknown>;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let files: string;

/** Sends a small file and waits for the antivirus. */
async function attach(person: Person, item: string, name: string): Promise<string> {
  const content = Buffer.from(`conteúdo de ${name}`);
  const started = await person.browser.post<{ id: string }>(`/api/items/${item}/attachments`, {
    name,
    size: content.length,
    type: 'text/plain',
  });
  expect(started.status).toBe(200);
  await person.browser.bytes('PUT', `/api/uploads/${started.body.id}/parts/0`, content);
  expect((await person.browser.post(`/api/uploads/${started.body.id}/finish`)).status).toBe(200);
  for (let round = 0; round < 100; round += 1) {
    const list = await person.browser.get<{ id: string; status: string }[]>(
      `/api/items/${item}/attachments`,
    );
    if (list.body.find((file) => file.id === started.body.id)?.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return started.body.id;
}

const save = (person: Person, item: string, value: unknown, field = files) =>
  person.browser.patch<Item & ErrorBody>(`/api/items/${item}`, { fields: { [field]: value } });

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const created = await s.owner.browser.post<{ id: string; config: unknown }>(
    `/api/lists/${s.tarefas}/fields`,
    { name: 'Contrato', kind: 'files' },
  );
  expect(created.status).toBe(200);
  expect(created.body.config).toEqual({});
  files = created.body.id;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('a files field', () => {
  it('names attachments of the item itself, and nothing else', async () => {
    const contract = await attach(s.ana, s.itemAna, 'contrato.pdf');
    const invoice = await attach(s.ana, s.itemAna, 'nota.pdf');
    const saved = await save(s.ana, s.itemAna, [contract, invoice]);
    expect(saved.status).toBe(200);
    expect(saved.body.fields[files]).toEqual([contract, invoice]);

    const elsewhere = await attach(s.bruno, s.itemBruno, 'do-bruno.pdf');
    for (const stranger of [elsewhere, randomUUID()]) {
      const refused = await save(s.ana, s.itemAna, [contract, stranger]);
      expect(refused.status).toBe(400);
      expect(refused.body.error.details?.problem).toBe('unknown_file');
    }
    const shapes: [unknown, string][] = [
      ['contrato.pdf', 'wrong_type'],
      [[], 'empty'],
      [[contract, contract], 'duplicate_file'],
      [Array.from({ length: 21 }, () => randomUUID()), 'too_many_files'],
    ];
    for (const [value, problem] of shapes) {
      const response = await save(s.ana, s.itemAna, value);
      expect(response.status, JSON.stringify(value)).toBe(400);
      expect(response.body.error.details?.problem).toBe(problem);
    }
  });

  it('keeps a file it already named after it leaves the item, but never names it again', async () => {
    const first = await attach(s.marta, s.itemNobody, 'primeiro.pdf');
    const second = await attach(s.marta, s.itemNobody, 'segundo.pdf');
    expect((await save(s.marta, s.itemNobody, [first])).status).toBe(200);
    await s.marta.browser.post(`/api/attachments/${first}/trash`);
    // Still named, and naming another one next to it is fine.
    expect((await save(s.marta, s.itemNobody, [first, second])).status).toBe(200);
    expect((await save(s.marta, s.itemNobody, [second])).status).toBe(200);
    // Gone from the value and from the item: it cannot come back.
    const again = await save(s.marta, s.itemNobody, [second, first]);
    expect(again.body.error.details?.problem).toBe('unknown_file');
    await s.marta.browser.post(`/api/attachments/${first}/restore`);
    expect((await save(s.marta, s.itemNobody, [second, first])).status).toBe(200);
  });

  it('moves with the item, keeping only what is still attached', async () => {
    const copied = await s.marta.browser.post<{ created: { id: string; name: string }[] }>(
      `/api/lists/${s.perfis}/fields/copy`,
      { fromListId: s.tarefas },
    );
    const there = copied.body.created.find((field) => field.name === 'Contrato')?.id;
    expect(there).toBeDefined();
    const kept = await attach(s.marta, s.itemNobody, 'fica.pdf');
    const dropped = await attach(s.marta, s.itemNobody, 'sai.pdf');
    expect((await save(s.marta, s.itemNobody, [dropped, kept])).status).toBe(200);
    await s.marta.browser.post(`/api/attachments/${dropped}/trash`);
    const moved = await s.marta.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: s.perfis,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.fields[there ?? '']).toEqual([kept]);

    // With nothing left attached, the value stays behind instead of blocking the move.
    await s.marta.browser.post(`/api/attachments/${kept}/trash`);
    const back = await s.marta.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: s.tarefas,
    });
    expect(back.status).toBe(200);
    expect(back.body.fields[files]).toEqual([dropped, kept]);
  });
});

describe('straight at the database', () => {
  it('nobody names a file of another item, an unfinished or thrown-away one, or one that does not exist', async () => {
    const theirs = await attach(s.bruno, s.itemBruno, 'alheio.pdf');
    const thrown = await attach(s.ana, s.itemAna, 'jogado-fora.pdf');
    await s.ana.browser.post(`/api/attachments/${thrown}/trash`);
    const unfinished = await s.ana.browser.post<{ id: string }>(
      `/api/items/${s.itemAna}/attachments`,
      { name: 'pela-metade.pdf', size: 10, type: '' },
    );
    expect(await bind(app, s.ana)).toBe(true);
    for (const stranger of [theirs, unfinished.body.id, thrown, randomUUID()]) {
      const result = await attempt(
        app,
        `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
        [s.itemAna, files, JSON.stringify([stranger])],
      );
      expect(result, stranger).toMatchObject({ ok: false, code: '23514' });
    }
    await app.query('ROLLBACK');
    // Not even the database's owner.
    await expect(
      env.admin.query(
        `UPDATE app.item_field_values SET value = $3 WHERE item_id = $1 AND field_id = $2`,
        [s.itemAna, files, JSON.stringify([theirs])],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
