import type { ReactNode } from 'react';
import type { Item, Stage } from '../api.js';
import { isoDay } from '../calendar.js';
import { dueState, dueText, priorityLabel } from '../due.js';

/** Stages that mean the work is over: what is in them is no longer late. */
export const finishedStages = (stages: readonly Stage[]): Set<string> =>
  new Set(
    stages.filter((stage) => stage.kind === 'done' || stage.kind === 'closed').map((s) => s.id),
  );

/** Priority and due date next to an item's title, when it has them. */
export function ItemMarks({ item, stages }: { item: Item; stages: readonly Stage[] }): ReactNode {
  if (item.priority === null && item.dueDate === null) return null;
  const today = isoDay(new Date());
  const state = dueState(item.dueDate, today, finishedStages(stages).has(item.stageId));
  const priority = priorityLabel(item.priority);
  return (
    <span className="item-marks">
      {priority !== null ? (
        <span className={`mark priority-${String(item.priority)}`}>
          <span className="visually-hidden">Prioridade </span>
          {priority}
        </span>
      ) : null}
      {item.dueDate !== null && state !== null ? (
        <span className={`mark due-${state}`}>{dueText(item.dueDate, today, state)}</span>
      ) : null}
    </span>
  );
}
