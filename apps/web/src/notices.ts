import { fullDay } from './due.js';
import { ruleName } from './history.js';

/*
 * A notification as a sentence. What is stored is a kind and some ids; what
 * people read is who did what to which item.
 */

export type NoticeKind =
  'mentioned' | 'assigned' | 'commented' | 'due_today' | 'overdue' | 'automation';

export interface NoticeLike {
  kind: NoticeKind;
  itemTitle: string;
  actorName: string | null;
  dueOn: string | null;
  automation?: { name: string | null } | null;
}

export function noticeSentence(notice: NoticeLike): string {
  const rule = notice.automation ? ruleName(notice.automation) : null;
  const who =
    rule === null ? (notice.actorName ?? 'Alguém') : rule.charAt(0).toUpperCase() + rule.slice(1);
  const item = `“${notice.itemTitle}”`;
  switch (notice.kind) {
    case 'mentioned':
      return `${who} mencionou você em ${item}`;
    case 'assigned':
      return `${who} passou ${item} para você`;
    case 'commented':
      return `${who} comentou em ${item}`;
    case 'due_today':
      return `${item} vence hoje`;
    case 'overdue':
      return notice.dueOn === null
        ? `${item} está atrasado`
        : `${item} está atrasado desde ${fullDay(notice.dueOn)}`;
    case 'automation':
      return `${who} chamou você para ${item}`;
  }
}
