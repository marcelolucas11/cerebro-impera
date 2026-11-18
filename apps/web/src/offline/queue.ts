import type { Item } from '../api.js';

/*
 * Changes made without a connection, waiting for it. Each one carries what
 * the person saw before making it, so the server can tell whether someone
 * else changed the same thing meanwhile. Nothing is ever dropped without the
 * person seeing it: a change is sent, or shown as in conflict or refused.
 */

/** What can be changed without a connection: the plain facts of an item. */
export const OFFLINE_FIELDS = ['title', 'stageId', 'priority', 'dueDate'] as const;
export type OfflineField = (typeof OFFLINE_FIELDS)[number];
export type OfflineChange = Partial<Pick<Item, OfflineField>>;

export interface QueuedChange {
  id: string;
  itemId: string;
  listId: string;
  /** The item's title when the change was made, to name it on screen. */
  itemTitle: string;
  change: OfflineChange;
  expected: OfflineChange;
  /** Stage names of the list when the change was made, to say them on screen. */
  stageNames: Record<string, string>;
  madeAt: number;
  state: 'waiting' | 'conflict' | 'refused';
  /** In conflict: what is there now, for the fields that moved. */
  current?: OfflineChange;
  /** Refused: why, in words. */
  reason?: string;
}

/** Whether a change can wait for the connection: only plain facts, at least one. */
export function queueable(change: Record<string, unknown>): change is OfflineChange {
  const keys = Object.keys(change);
  return (
    keys.length > 0 && keys.every((key) => (OFFLINE_FIELDS as readonly string[]).includes(key))
  );
}

/** What the person saw of the fields they changed. */
export function expectationOf(item: Item, change: OfflineChange): OfflineChange {
  const seen: OfflineChange = {};
  for (const key of OFFLINE_FIELDS) {
    if (key in change) Object.assign(seen, { [key]: item[key] });
  }
  return seen;
}

/** The item as it reads with the change. */
export function applied(item: Item, change: OfflineChange): Item {
  return { ...item, ...change };
}

/** A later change to the same field of the same item replaces the waiting one, keeping what was first seen. */
export function enqueue(queue: readonly QueuedChange[], next: QueuedChange): QueuedChange[] {
  const waiting = queue.find((entry) => entry.state === 'waiting' && entry.itemId === next.itemId);
  if (waiting === undefined) return [...queue, next];
  return queue.map((entry) =>
    entry === waiting
      ? {
          ...entry,
          change: { ...entry.change, ...next.change },
          expected: { ...next.expected, ...entry.expected },
          stageNames: { ...entry.stageNames, ...next.stageNames },
        }
      : entry,
  );
}

const FIELD_NAMES: Record<OfflineField, string> = {
  title: 'no título',
  stageId: 'na etapa',
  priority: 'na prioridade',
  dueDate: 'no prazo',
};

/** One value in words: a stage by its name, a day as people write it. */
export function valueText(
  field: OfflineField,
  value: OfflineChange[OfflineField],
  stageNames: Record<string, string>,
): string {
  if (value === null || value === undefined) return 'vazio';
  if (field === 'stageId') return stageNames[String(value)] ?? 'outra etapa';
  if (field === 'dueDate') {
    const [year, month, day] = String(value).split('-');
    return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
  }
  return String(value);
}

/** "na etapa, a sua é Feito e a de lá é Bloqueado", for each field that moved. */
export function conflictText(entry: QueuedChange): string {
  const current = entry.current ?? {};
  return OFFLINE_FIELDS.filter((field) => field in current)
    .map(
      (field) =>
        `${FIELD_NAMES[field]}, a sua é ${valueText(field, entry.change[field], entry.stageNames)} e a de lá é ${valueText(field, current[field], entry.stageNames)}`,
    )
    .join('; ');
}
