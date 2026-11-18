import { describe, expect, it } from 'vitest';
import type { Home, Tree } from '../src/api.js';
import { expired, keepable, keptPart, OFFLINE_DAYS } from '../src/offline/policy.js';
import { newKey, seal, unseal } from '../src/offline/vault.js';

const OPEN = '11111111-1111-4111-8111-111111111111';
const SENSITIVE = '22222222-2222-4222-8222-222222222222';
const tree: Tree = {
  spaces: [{ id: 's', name: 'Operação', canManage: false }],
  folders: [],
  lists: [
    {
      id: OPEN,
      spaceId: 's',
      folderId: null,
      name: 'Tarefas',
      isSensitive: false,
      level: 'edit',
      itemScope: 'all',
    },
    {
      id: SENSITIVE,
      spaceId: 's',
      folderId: null,
      name: 'Dinheiro',
      isSensitive: true,
      level: 'view',
      itemScope: 'all',
    },
  ],
};

describe('what a device keeps to read offline', () => {
  it('keeps the account, the structure, the start page and lists that are not sensitive', () => {
    for (const path of ['/api/me', '/api/tree', '/api/home']) {
      expect(keepable(path, null), path).toBe(true);
    }
    for (const part of ['items', 'stages', 'fields']) {
      expect(keepable(`/api/lists/${OPEN}/${part}`, tree), part).toBe(true);
      expect(keepable(`/api/lists/${SENSITIVE}/${part}`, tree), part).toBe(false);
    }
  });

  it('keeps nothing of a list it cannot tell is not sensitive, and nothing else', () => {
    expect(keepable(`/api/lists/${OPEN}/items`, null)).toBe(false);
    expect(keepable('/api/lists/33333333-3333-4333-8333-333333333333/items', tree)).toBe(false);
    for (const path of [
      `/api/lists/${OPEN}/items?x=1`,
      `/api/lists/${OPEN}/fields?archived=1`,
      `/api/lists/${OPEN}/people`,
      `/api/lists/${OPEN}/summary`,
      '/api/items/1/checklist',
      '/api/notifications',
      '/api/attachments/1/download',
      '/api/audit',
      '/api/users',
      '/api/setup/status',
    ]) {
      expect(keepable(path, tree), path).toBe(false);
    }
  });

  it('keeps the start page without anything from a sensitive or unknown list', () => {
    const home: Home = {
      items: [
        {
          id: 'a',
          title: 'Aberto',
          listId: OPEN,
          listName: 'Tarefas',
          stageName: 'A fazer',
          dueDate: null,
          priority: null,
          due: 'later',
        },
        {
          id: 'b',
          title: 'Segredo',
          listId: SENSITIVE,
          listName: 'Dinheiro',
          stageName: 'A fazer',
          dueDate: null,
          priority: null,
          due: 'later',
        },
        {
          id: 'c',
          title: 'Outra',
          listId: 'x',
          listName: 'Outra',
          stageName: 'A fazer',
          dueDate: null,
          priority: null,
          due: 'later',
        },
      ],
      unread: 2,
      pins: [SENSITIVE, OPEN],
    };
    const kept = keptPart('/api/home', home, tree) as Home;
    expect(kept.items.map((item) => item.id)).toEqual(['a']);
    expect(kept.pins).toEqual([OPEN]);
    expect((keptPart('/api/home', home, null) as Home).items).toEqual([]);
    expect(keptPart('/api/me', { id: 1 }, tree)).toEqual({ id: 1 });
  });

  it('forgets everything after days without the server, or when it never heard from it', () => {
    const now = Date.UTC(2026, 10, 18);
    const day = 24 * 60 * 60 * 1000;
    expect(expired(now - (OFFLINE_DAYS * day - 1), now)).toBe(false);
    expect(expired(now - (OFFLINE_DAYS * day + 1), now)).toBe(true);
    expect(expired(null, now)).toBe(true);
  });
});

describe('the lock on what is kept', () => {
  it('opens what it sealed, only in the same slot, with a new nonce every time', async () => {
    const key = await newKey();
    const value = { title: 'Pagar o aluguel', n: 3 };
    const first = await seal(key, '/api/me', value);
    const second = await seal(key, '/api/me', value);
    expect(await unseal(key, '/api/me', first)).toEqual(value);
    expect(await unseal(key, '/api/tree', first)).toBeUndefined();
    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(Buffer.from(first.data).toString('utf8')).not.toContain('aluguel');
    expect(await unseal(await newKey(), '/api/me', first)).toBeUndefined();
  });

  it('uses a key the page can use but never read', async () => {
    const key = await newKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});
