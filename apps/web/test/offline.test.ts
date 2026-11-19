import { describe, expect, it } from 'vitest';
import type { Home, Tree } from '../src/api.js';
import {
  expired,
  homeAfter,
  keepable,
  keptPart,
  listOf,
  noLongerKeepable,
  OFFLINE_DAYS,
} from '../src/offline/policy.js';
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

  it('takes from the kept start page what came from a list she no longer sees as before', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const item = (id: string, listId: string): Home['items'][number] => ({
      id,
      title: id,
      listId,
      listName: id,
      stageName: 'A fazer',
      dueDate: null,
      priority: null,
      due: 'later',
    });
    const before: Tree = {
      ...tree,
      lists: [
        ...tree.lists.map((list) => ({ ...list, isSensitive: false })),
        {
          id: OTHER,
          spaceId: 's',
          folderId: null,
          name: 'Compras',
          isSensitive: false,
          level: 'edit',
          itemScope: 'all',
        },
      ],
    };
    const home: Home = {
      items: [item('a', OPEN), item('b', SENSITIVE), item('c', OTHER)],
      unread: 0,
      pins: [OPEN, SENSITIVE, OTHER],
    };
    // Nothing changed: everything stays.
    expect(homeAfter(home, before, before)).toEqual(home);
    // SENSITIVE became sensitive, OTHER was taken from her: only OPEN stays.
    const after = homeAfter(home, before, tree);
    expect(after.items.map((kept) => kept.id)).toEqual(['a']);
    expect(after.pins).toEqual([OPEN]);
    expect(after.unread).toBe(0);
    // OPEN now seen only for the items given to her: it goes too.
    const narrower: Tree = {
      ...before,
      lists: before.lists.map((list) =>
        list.id === OPEN ? { ...list, itemScope: 'assigned' as const } : list,
      ),
    };
    expect(homeAfter(home, before, narrower).items.map((kept) => kept.id)).toEqual(['b', 'c']);
    // With no structure kept before, nothing can be told apart: everything goes.
    expect(homeAfter(home, null, before).items).toEqual([]);
  });

  it('keeps the structure without the sensitive lists, not even their names', () => {
    const kept = keptPart('/api/tree', tree, tree) as Tree;
    expect(kept.lists.map((list) => list.id)).toEqual([OPEN]);
    expect(JSON.stringify(kept)).not.toContain('Dinheiro');
    expect(kept.spaces).toEqual(tree.spaces);
  });

  it('drops a list she no longer sees as when it was kept', () => {
    const items = `/api/lists/${OPEN}/items`;
    expect(listOf(items)).toBe(OPEN);
    expect(listOf('/api/home')).toBeUndefined();
    const open = tree.lists[0];
    if (open === undefined) throw new Error('no list');
    const as = (changes: Partial<typeof open> | null): Tree => ({
      ...tree,
      lists: changes === null ? [] : [{ ...open, ...changes }],
    });
    // The same: it stays. Anything that is not a list's part is not this rule's to drop.
    expect(noLongerKeepable(items, tree, as({}))).toBe(false);
    expect(noLongerKeepable('/api/home', tree, as(null))).toBe(false);
    // Gone, now sensitive, another level, now only her own items, or never seen before: it goes.
    expect(noLongerKeepable(items, tree, as(null))).toBe(true);
    expect(noLongerKeepable(items, tree, as({ isSensitive: true }))).toBe(true);
    expect(noLongerKeepable(items, tree, as({ level: 'view' }))).toBe(true);
    expect(noLongerKeepable(items, tree, as({ itemScope: 'assigned' }))).toBe(true);
    expect(noLongerKeepable(items, null, as({}))).toBe(true);
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
