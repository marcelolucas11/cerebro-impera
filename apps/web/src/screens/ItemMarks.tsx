import type { ReactNode } from 'react';
import type { Item, Stage } from '../api.js';
import { isoDay } from '../calendar.js';
import { dueState, dueText, priorityLabel, recurrenceText } from '../due.js';

/** Stages that mean the work is over: what is in them is no longer late. */
export const finishedStages = (stages: readonly Stage[]): Set<string> =>
  new Set(
    stages.filter((stage) => stage.kind === 'done' || stage.kind === 'closed').map((s) => s.id),
  );

/**
 * What to know at a glance next to an item's title: its priority, its due
 * date, how many of its subtasks are done, and which item it hangs from.
 * Everything comes from items the person already received: a parent they
 * cannot see is only "a subtask".
 */
export function ItemMarks({
  item,
  stages,
  everyone = [],
  showParent = true,
}: {
  item: Item;
  stages: readonly Stage[];
  /** Every item of the list the person received, to count subtasks and name the parent. */
  everyone?: readonly Item[];
  showParent?: boolean;
}): ReactNode {
  const finished = finishedStages(stages);
  const children = everyone.filter((other) => other.parentId === item.id);
  const parent =
    item.parentId === null ? undefined : everyone.find((other) => other.id === item.parentId);
  if (
    item.priority === null &&
    item.dueDate === null &&
    children.length === 0 &&
    item.checks.total === 0 &&
    item.comments === 0 &&
    item.recurrence === null &&
    (item.parentId === null || !showParent)
  ) {
    return null;
  }
  const today = isoDay(new Date());
  const state = dueState(item.dueDate, today, finished.has(item.stageId));
  const priority = priorityLabel(item.priority);
  const done = children.filter((child) => finished.has(child.stageId)).length;
  return (
    <span className="item-marks">
      {item.parentId !== null && showParent ? (
        <span className="mark">{parent ? `Subtarefa de ${parent.title}` : 'Subtarefa'}</span>
      ) : null}
      {priority !== null ? (
        <span className={`mark priority-${String(item.priority)}`}>
          <span className="visually-hidden">Prioridade </span>
          {priority}
        </span>
      ) : null}
      {item.dueDate !== null && state !== null ? (
        <span className={`mark due-${state}`}>{dueText(item.dueDate, today, state)}</span>
      ) : null}
      {item.recurrence !== null ? (
        <span className="mark">Repete {recurrenceText(item.recurrence)}</span>
      ) : null}
      {item.checks.total > 0 ? (
        <span className={item.checks.done === item.checks.total ? 'mark checks-done' : 'mark'}>
          Checklist {item.checks.done}/{item.checks.total}
        </span>
      ) : null}
      {item.comments > 0 ? (
        <span className="mark">
          {item.comments === 1 ? '1 comentário' : `${String(item.comments)} comentários`}
        </span>
      ) : null}
      {children.length > 0 ? (
        <span className="mark">
          {done}/{children.length}{' '}
          {children.length === 1 ? 'subtarefa concluída' : 'subtarefas concluídas'}
        </span>
      ) : null}
    </span>
  );
}
