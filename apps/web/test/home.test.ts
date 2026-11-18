import { MAX_HOME_PINS } from '@cerebro/shared';
import { describe, expect, it } from 'vitest';
import type { HomeItem, Tree } from '../src/api.js';
import { groupItems, listPlace, movePin, pin, pinChoices, unpin } from '../src/home.js';

const item = (id: string, due: HomeItem['due']): HomeItem => ({
  id,
  title: id,
  listId: 'l1',
  listName: 'Tarefas',
  stageName: 'A fazer',
  dueDate: null,
  priority: null,
  due,
});

const tree: Tree = {
  spaces: [
    { id: 's1', name: 'Operação', canManage: true },
    { id: 's2', name: 'Administrativo', canManage: false },
  ],
  folders: [{ id: 'f1', spaceId: 's1', name: 'Clientes', canManage: true }],
  lists: [
    {
      id: 'l1',
      spaceId: 's1',
      folderId: null,
      name: 'Tarefas',
      isSensitive: false,
      level: 'edit',
      itemScope: 'all',
    },
    {
      id: 'l2',
      spaceId: 's1',
      folderId: 'f1',
      name: 'Entregas',
      isSensitive: false,
      level: 'view',
      itemScope: 'all',
    },
    {
      id: 'l3',
      spaceId: 's2',
      folderId: null,
      name: 'Contas',
      isSensitive: true,
      level: 'view',
      itemScope: 'assigned',
    },
  ],
};

describe('the items on the start page', () => {
  it('come in the order they press, only the groups that have any, keeping the server order', () => {
    const groups = groupItems([
      item('depois', 'later'),
      item('hoje', 'today'),
      item('atrasado-1', 'overdue'),
      item('atrasado-2', 'overdue'),
    ]);
    expect(groups.map((group) => [group.title, group.items.map((one) => one.id)])).toEqual([
      ['Atrasados', ['atrasado-1', 'atrasado-2']],
      ['Vencem hoje', ['hoje']],
      ['Mais adiante ou sem prazo', ['depois']],
    ]);
  });
});

describe('the pinned panels', () => {
  it('move one place at a time and stay put at the ends', () => {
    expect(movePin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movePin(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(movePin(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(movePin(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(movePin(['a', 'b'], 'x', 1)).toEqual(['a', 'b']);
  });

  it('are added last, once, up to the limit, and removed by themselves', () => {
    expect(pin(['a'], 'b')).toEqual(['a', 'b']);
    expect(pin(['a', 'b'], 'a')).toEqual(['a', 'b']);
    const full = Array.from({ length: MAX_HOME_PINS }, (_, index) => `l${String(index)}`);
    expect(pin(full, 'outra')).toEqual(full);
    expect(unpin(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('offer the lists not yet pinned, named by where they sit', () => {
    expect(listPlace(tree, 'l2')).toBe('Operação / Clientes / Entregas');
    expect(listPlace(tree, 'nenhuma')).toBeNull();
    expect(pinChoices(tree, ['l1'])).toEqual([
      { id: 'l3', label: 'Administrativo / Contas' },
      { id: 'l2', label: 'Operação / Clientes / Entregas' },
    ]);
  });
});
