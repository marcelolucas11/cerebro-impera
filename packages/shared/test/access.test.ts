import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canManageUser,
  checkPassword,
  mayGrant,
  resolveFolderAccess,
  resolveListAccess,
  resolveSpaceAccess,
  type AccessGrant,
} from '../src/index.js';

const SPACE = '00000000-0000-4000-8000-000000000001';
const FOLDER = '00000000-0000-4000-8000-000000000002';
const LIST = '00000000-0000-4000-8000-000000000003';
const location = { listId: LIST, folderId: FOLDER, spaceId: SPACE };

function grant(partial: Partial<AccessGrant>): AccessGrant {
  return {
    spaceId: null,
    folderId: null,
    listId: null,
    level: 'view',
    itemScope: 'assigned',
    ...partial,
  };
}

describe('access resolution', () => {
  it('gives owners everything without any grant', () => {
    expect(resolveListAccess('owner', [], location)).toEqual({ level: 'manage', itemScope: 'all' });
    expect(resolveSpaceAccess('owner', [], SPACE).level).toBe('manage');
  });

  it('gives nobody else anything without a grant', () => {
    for (const role of ['admin', 'manager', 'employee'] as const) {
      expect(resolveListAccess(role, [], location).level).toBe('none');
      expect(resolveFolderAccess(role, [], { folderId: FOLDER, spaceId: SPACE }).level).toBe(
        'none',
      );
      expect(resolveSpaceAccess(role, [], SPACE).level).toBe('none');
    }
  });

  it('inherits from the space down to the list', () => {
    const grants = [grant({ spaceId: SPACE, level: 'edit', itemScope: 'all' })];
    expect(resolveListAccess('admin', grants, location)).toEqual({
      level: 'edit',
      itemScope: 'all',
    });
  });

  it('lets the most specific grant win, including an explicit "none"', () => {
    const grants = [
      grant({ spaceId: SPACE, level: 'manage', itemScope: 'all' }),
      grant({ folderId: FOLDER, level: 'view', itemScope: 'all' }),
      grant({ listId: LIST, level: 'none' }),
    ];
    expect(resolveListAccess('admin', grants, location).level).toBe('none');
    expect(resolveFolderAccess('admin', grants, { folderId: FOLDER, spaceId: SPACE }).level).toBe(
      'view',
    );
    expect(resolveSpaceAccess('admin', grants, SPACE).level).toBe('manage');
  });

  it('ignores grants that belong to other scopes', () => {
    const grants = [grant({ listId: '00000000-0000-4000-8000-0000000000ff', level: 'manage' })];
    expect(resolveListAccess('employee', grants, location).level).toBe('none');
  });
});

describe('granting', () => {
  it('requires full management of the scope', () => {
    expect(mayGrant('admin', { level: 'edit', itemScope: 'all' }, { itemScope: 'assigned' })).toBe(
      false,
    );
    expect(mayGrant('admin', { level: 'manage', itemScope: 'all' }, { itemScope: 'all' })).toBe(
      true,
    );
  });

  it('does not let someone widen item visibility beyond their own', () => {
    expect(
      mayGrant('admin', { level: 'manage', itemScope: 'assigned' }, { itemScope: 'all' }),
    ).toBe(false);
  });
});

describe('chain of command', () => {
  const admin = { id: 'a', role: 'admin', canManageUsers: true } as const;

  it('never lets a non-owner administer peers, superiors or themselves', () => {
    expect(canManageUser(admin, { id: 'b', role: 'admin' })).toBe(false);
    expect(canManageUser(admin, { id: 'o', role: 'owner' })).toBe(false);
    expect(canManageUser(admin, { id: 'a', role: 'admin' })).toBe(false);
    expect(canManageUser(admin, { id: 'e', role: 'employee' })).toBe(true);
  });

  it('requires the capability', () => {
    expect(canManageUser({ ...admin, canManageUsers: false }, { id: 'e', role: 'employee' })).toBe(
      false,
    );
    expect(assignableRoles({ role: 'admin', canManageUsers: false })).toEqual([]);
  });

  it('only offers roles strictly below the actor', () => {
    expect(assignableRoles(admin)).toEqual(['employee', 'manager']);
    expect(assignableRoles({ role: 'owner', canManageUsers: false })).toContain('owner');
  });
});

describe('password policy', () => {
  it('accepts a long, varied passphrase', () => {
    expect(checkPassword('lagoa-verde-73-tijolo-quente')).toEqual([]);
  });

  it('rejects short, common, repetitive and identity-based passwords', () => {
    expect(checkPassword('curta')).toContain('too_short');
    expect(checkPassword('Password1234')).toContain('too_common');
    expect(checkPassword('aaaaaaaaaaaaaaaa')).toContain('low_variety');
    expect(
      checkPassword('mariana-2024-forte!', { email: 'mariana@exemplo.com', name: 'Mariana Souza' }),
    ).toContain('contains_identity');
  });
});
