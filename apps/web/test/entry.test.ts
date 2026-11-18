import { describe, expect, it } from 'vitest';
import { canEnter, ENTRY_NAMES } from '../src/entry.js';

describe('who the page offers a stage to', () => {
  it('offers an open stage to anyone, and a restricted one from its role up', () => {
    expect(canEnter({ entryRole: null }, 'employee')).toBe(true);
    expect(canEnter({ entryRole: null }, undefined)).toBe(true);
    expect(canEnter({ entryRole: 'manager' }, 'employee')).toBe(false);
    expect(canEnter({ entryRole: 'manager' }, 'manager')).toBe(true);
    expect(canEnter({ entryRole: 'admin' }, 'manager')).toBe(false);
    expect(canEnter({ entryRole: 'admin' }, 'owner')).toBe(true);
    expect(canEnter({ entryRole: 'owner' }, 'admin')).toBe(false);
    expect(canEnter({ entryRole: 'owner' }, undefined)).toBe(false);
  });

  it('names each choice the way the team says it', () => {
    expect(Object.values(ENTRY_NAMES)).toEqual([
      'Quem edita o item',
      'Gestores ou acima',
      'ADMs ou acima',
      'Só Donos',
    ]);
  });
});
