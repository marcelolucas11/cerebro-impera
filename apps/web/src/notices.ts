import { fullDay } from './due.js';

/*
 * A notification as a sentence. What is stored is a kind and some ids; what
 * people read is who did what to which item.
 */

export type NoticeKind = 'mentioned' | 'assigned' | 'commented' | 'due_today' | 'overdue';

export interface NoticeLike {
  kind: NoticeKind;
  itemTitle: string;
  actorName: string | null;
  dueOn: string | null;
}

export function noticeSentence(notice: NoticeLike): string {
  const who = notice.actorName ?? 'Alguém';
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
  }
}
