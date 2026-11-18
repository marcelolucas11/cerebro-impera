import { useQuery } from '@tanstack/react-query';
import { api, type Role, type Stage, type StageEntryRole } from './api.js';

/*
 * Who may put items into a stage. The database decides; the page only
 * avoids offering a choice that would be refused.
 */

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };

/** Whether someone with this role may move an item into the stage. */
export function canEnter(stage: Pick<Stage, 'entryRole'>, role: Role | undefined): boolean {
  if (stage.entryRole === null) return true;
  return role !== undefined && RANK[role] >= RANK[stage.entryRole];
}

export const ENTRY_NAMES: Record<StageEntryRole | 'anyone', string> = {
  anyone: 'Quem edita o item',
  manager: 'Gestores ou acima',
  admin: 'ADMs ou acima',
  owner: 'Só Donos',
};

/** The signed-in person's role, from the page's own copy of who is signed in. */
export function useMyRole(): Role | undefined {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  return me.data?.user.role;
}
