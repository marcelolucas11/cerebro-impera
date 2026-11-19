import type pg from 'pg';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, parseAnnouncement, type LiveEvent, type Listener } from '../src/live.js';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Live updates: the database announces only which list and item changed and
 * whose the item is; the server passes that only to people who can open the
 * list, and, where they see only their own items, only when it is theirs.
 */

const listener = (
  userId: string,
  lists: [string, 'all' | 'assigned'][],
): Listener & { got: LiveEvent[]; refreshed: number } => {
  const got: LiveEvent[] = [];
  const self = {
    userId,
    lists: new Map(lists),
    got,
    refreshed: 0,
    send: (event: LiveEvent) => {
      got.push(event);
    },
    refresh: () => {
      self.refreshed += 1;
    },
  };
  return self;
};

describe('who hears what', () => {
  it('passes list changes to whoever opens the list, and item changes only to whom they concern', () => {
    const boss = listener('dona', [['tarefas', 'all']]);
    const ana = listener('ana', [['tarefas', 'assigned']]);
    const outsider = listener('nuno', []);
    const everyone = [boss, ana, outsider];
    deliver({ l: 'tarefas' }, everyone);
    deliver({ l: 'tarefas', i: 'do-bruno', p: ['dona', 'bruno'] }, everyone);
    deliver({ l: 'tarefas', i: 'da-ana', p: ['dona', 'ana'] }, everyone);
    deliver({ l: 'dinheiro', i: 'conta', p: ['dona'] }, everyone);
    expect(boss.got).toEqual([
      { list: 'tarefas' },
      { list: 'tarefas', item: 'do-bruno' },
      { list: 'tarefas', item: 'da-ana' },
    ]);
    expect(ana.got).toEqual([{ list: 'tarefas' }, { list: 'tarefas', item: 'da-ana' }]);
    expect(outsider.got).toEqual([]);
  });

  it('tells only the person of their notifications and of their access', () => {
    const ana = listener('ana', []);
    const bruno = listener('bruno', []);
    deliver({ u: 'ana' }, [ana, bruno]);
    deliver({ g: 'bruno' }, [ana, bruno]);
    expect(ana.got).toEqual([{ notifications: true }]);
    expect(bruno.got).toEqual([{ access: true }]);
    expect(bruno.refreshed).toBe(1);
    expect(ana.refreshed).toBe(0);
  });

  it('ignores what is not an announcement', () => {
    expect(parseAnnouncement('not json')).toBeNull();
    expect(parseAnnouncement('[1]')).toBeNull();
    expect(parseAnnouncement(undefined)).toBeNull();
    expect(parseAnnouncement('{"l":"x","p":["a",2],"t":"title"}')).toEqual({ l: 'x', p: ['a'] });
  });
});

let env: TestEnv;
let s: Scenario;
let base = '';

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${String((env.app.server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await env.close();
});

describe('what the database announces', () => {
  it('says which list and item changed and whose it is, and never what it says', async () => {
    const client: pg.PoolClient = await env.admin.connect();
    const heard: Record<string, unknown>[] = [];
    client.on('notification', (message) => {
      heard.push(JSON.parse(message.payload ?? '{}') as Record<string, unknown>);
    });
    await client.query('LISTEN cerebro_live');
    try {
      await s.owner.browser.patch(`/api/items/${s.itemAna}`, { title: 'Segredo no título' });
      await s.owner.browser.post(`/api/items/${s.itemAna}/comments`, { body: 'Texto privado' });
      await s.owner.browser.post(`/api/lists/${s.tarefas}/stages`, { name: 'Nova etapa' });
      await s.owner.browser.put('/api/grants', {
        userId: s.nuno.id,
        scopeType: 'list',
        scopeId: s.perfis,
        level: 'view',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const forAna = heard.filter((one) => one.i === s.itemAna);
      expect(forAna.length).toBeGreaterThan(0);
      for (const one of forAna) {
        expect(one).toMatchObject({ l: s.tarefas, i: s.itemAna });
        expect([...(one.p as string[])].sort()).toEqual([s.owner.id, s.ana.id].sort());
      }
      expect(heard).toContainEqual({ l: s.tarefas });
      expect(heard).toContainEqual({ g: s.nuno.id });
      expect(heard.some((one) => one.u === s.ana.id)).toBe(true);
      // Only ids, never what anything says.
      const said = JSON.stringify(heard);
      expect(said).not.toContain('Segredo');
      expect(said).not.toContain('privado');
      for (const one of heard) {
        expect(Object.keys(one).every((key) => ['l', 'i', 'p', 'u', 'g'].includes(key))).toBe(true);
      }
    } finally {
      await client.query('UNLISTEN cerebro_live');
      client.release();
    }
  });
});

/** An open page's stream, as a browser would read it. */
async function openStream(person: Person) {
  const cookie = [...person.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  const events: LiveEvent[] = [];
  let ready = false;
  if (response.ok && response.body !== null) {
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for await (const chunk of body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (block.startsWith('event: ready')) ready = true;
            else if (block.startsWith('data: '))
              events.push(JSON.parse(block.slice(6)) as LiveEvent);
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Closed by the test.
      }
    })();
  }
  const until = async (check: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  };
  await until(() => ready);
  return {
    status: response.status,
    headers: response.headers,
    events,
    until,
    close: () => {
      controller.abort();
    },
  };
}

describe('the stream', () => {
  it('tells each open page only what concerns it', async () => {
    const owner = await openStream(s.owner);
    const ana = await openStream(s.ana);
    try {
      expect(ana.status).toBe(200);
      expect(ana.headers.get('content-type')).toContain('text/event-stream');
      expect(ana.headers.get('cache-control')).toBe('no-store');
      await s.owner.browser.patch(`/api/items/${s.itemBruno}`, { title: 'Do Bruno, mudado' });
      await s.owner.browser.patch(`/api/items/${s.itemAna}`, { title: 'Da Ana, mudado' });
      await s.owner.browser.patch(`/api/items/${s.itemMoney}`, { title: 'Conta, mudada' });
      await ana.until(() => ana.events.some((one) => one.item === s.itemAna));
      await owner.until(() => owner.events.some((one) => one.item === s.itemAna));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ana.events).toContainEqual({ list: s.tarefas, item: s.itemAna });
      // Bruno's item and the sensitive list are not hers to hear of.
      expect(ana.events.some((one) => one.item === s.itemBruno)).toBe(false);
      expect(ana.events.some((one) => one.list === s.dinheiro)).toBe(false);
      expect(owner.events).toContainEqual({ list: s.tarefas, item: s.itemBruno });
      // Her notifications too.
      await s.owner.browser.post(`/api/items/${s.itemAna}/comments`, { body: 'Ana?' });
      await ana.until(() => ana.events.some((one) => one.notifications === true));
      expect(ana.events).toContainEqual({ notifications: true });
    } finally {
      owner.close();
      ana.close();
    }
  });

  it('does not count as activity: an open tab alone lets the session go idle', async () => {
    const ago = async (): Promise<number> =>
      (
        await env.admin.query<{ s: number }>(
          `SELECT extract(epoch FROM now() - max(last_seen_at))::int AS s FROM auth.sessions
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [s.nuno.id],
        )
      ).rows[0]?.s ?? -1;
    await env.admin.query(
      `UPDATE auth.sessions SET last_seen_at = now() - interval '10 minutes' WHERE user_id = $1`,
      [s.nuno.id],
    );
    const stream = await openStream(s.nuno);
    try {
      expect(stream.status).toBe(200);
      expect(await ago()).toBeGreaterThanOrEqual(599);
    } finally {
      stream.close();
    }
    // Anything she does counts.
    expect((await s.nuno.browser.get('/api/me')).status).toBe(200);
    expect(await ago()).toBeLessThan(5);
  });

  it('is only for a signed-in person, and only a few at a time', async () => {
    const response = await fetch(`${base}/api/events`);
    expect(response.status).toBe(401);
    const streams = [];
    for (let n = 0; n < 5; n += 1) streams.push(await openStream(s.bruno));
    try {
      expect(streams.every((one) => one.status === 200)).toBe(true);
      const sixth = await openStream(s.bruno);
      expect(sixth.status).toBe(409);
      sixth.close();
    } finally {
      for (const one of streams) one.close();
    }
  });
});
