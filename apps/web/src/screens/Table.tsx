import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type CustomField, type Item, type Stage } from '../api.js';
import { canEnter, useMyRole } from '../entry.js';
import { Cancelled } from '../cancelled.js';
import {
  defaultColumns,
  FIXED_COLUMNS,
  type Columns,
  type Sort,
  type SortKey,
} from '../filters.js';
import { isoDay } from '../calendar.js';
import { dueState, formatDay, priorityLabel } from '../due.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Notice } from '../ui/kit.js';
import { ItemDialog, type PanelProps } from './Board.js';
import { FieldValueView } from './FieldInput.js';
import { finishedStages } from './ItemMarks.js';

const FIXED_NAMES: Record<(typeof FIXED_COLUMNS)[number], string> = {
  etapa: 'Etapa',
  responsaveis: 'Responsáveis',
  prioridade: 'Prioridade',
  inicio: 'Início',
  prazo: 'Prazo',
  criado: 'Criado em',
  atualizado: 'Atualizado em',
};
const FIXED_SORT: Partial<Record<string, SortKey>> = {
  prioridade: 'priority',
  inicio: 'start',
  prazo: 'due',
  criado: 'created',
  atualizado: 'updated',
};
const isFixed = (id: string): id is (typeof FIXED_COLUMNS)[number] =>
  (FIXED_COLUMNS as readonly string[]).includes(id);

/** Fields a column is sorted by: not secrets, files or long texts. */
const sortable = (field: CustomField): boolean =>
  field.kind !== 'secret' && field.kind !== 'files' && field.kind !== 'long_text';

/*
 * The list as a table: one row per item, the columns each person chooses,
 * sorted by clicking a column's name. The choice of columns goes in the
 * address with the filter, so a saved view keeps it.
 */
export function Table({
  stages,
  items,
  sort,
  columns,
  onSort,
  onColumns,
  ...panel
}: PanelProps & {
  stages: Stage[];
  items: Item[];
  sort: Sort;
  columns: Columns;
  onSort: (sort: Sort) => void;
  onColumns: (columns: Columns) => void;
}): ReactNode {
  const role = useMyRole();
  const { fields, canEdit, nameOf } = panel;
  const queryClient = useQueryClient();
  const guard = useGuard();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = items.find((item) => item.id === openId);
  const chosen = (columns ?? defaultColumns(fields)).filter(
    (id) => isFixed(id) || fields.some((field) => field.id === id),
  );
  // Every choice in one order: the fixed columns first, then fields as the list orders them.
  const everyColumn = [...FIXED_COLUMNS, ...fields.map((field) => field.id)];
  const nameOfColumn = (id: string): string =>
    isFixed(id) ? FIXED_NAMES[id] : (fields.find((field) => field.id === id)?.name ?? '');
  const sortKeyOf = (id: string): SortKey | undefined => {
    if (isFixed(id)) return FIXED_SORT[id];
    const field = fields.find((candidate) => candidate.id === id);
    return field && sortable(field) ? `field:${field.id}` : undefined;
  };

  const move = useCallback(
    async (item: Item, stageId: string) => {
      setError(null);
      try {
        await guard(() => api.updateItem(item.id, { stageId }));
      } catch (failure) {
        if (!(failure instanceof Cancelled)) setError(describeError(failure));
      } finally {
        await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      }
    },
    [guard, queryClient],
  );

  const header = (id: string, label: string, key: SortKey | undefined): ReactNode => {
    const active = key !== undefined && sort.key === key;
    return (
      <th
        key={id}
        scope="col"
        aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
      >
        {key === undefined ? (
          label
        ) : (
          <button
            type="button"
            className="table-sort"
            onClick={() => {
              onSort({ key, descending: active ? !sort.descending : false });
            }}
          >
            {label}
            <span aria-hidden="true">{active ? (sort.descending ? ' ↓' : ' ↑') : ''}</span>
          </button>
        )}
      </th>
    );
  };

  const today = isoDay(new Date());
  const finished = finishedStages(stages);
  const cell = (item: Item, id: string): ReactNode => {
    if (id === 'etapa') {
      const stage = stages.find((candidate) => candidate.id === item.stageId);
      return canEdit ? (
        <select
          className="stage-select"
          aria-label={`Etapa de ${item.title}`}
          value={item.stageId}
          onChange={(event) => {
            void move(item, event.target.value);
          }}
        >
          {stages.map((candidate) => (
            <option
              key={candidate.id}
              value={candidate.id}
              disabled={candidate.id !== item.stageId && !canEnter(candidate, role)}
            >
              {candidate.name}
            </option>
          ))}
        </select>
      ) : (
        (stage?.name ?? '')
      );
    }
    if (id === 'responsaveis') {
      return item.assignees.map((userId) => nameOf(userId)).join(', ');
    }
    if (id === 'prioridade') return priorityLabel(item.priority);
    if (id === 'inicio') return item.startDate === null ? null : formatDay(item.startDate, today);
    if (id === 'prazo') {
      if (item.dueDate === null) return null;
      const state = dueState(item.dueDate, today, finished.has(item.stageId));
      return (
        <span className={state === 'overdue' ? 'due-overdue' : undefined}>
          {formatDay(item.dueDate, today)}
          {state === 'overdue' ? <span className="visually-hidden"> (atrasado)</span> : null}
        </span>
      );
    }
    if (id === 'criado') return formatWhen(item.createdAt);
    if (id === 'atualizado') return formatWhen(item.updatedAt);
    const field = fields.find((candidate) => candidate.id === id);
    if (!field) return null;
    if (field.kind === 'secret') {
      return item.secrets.includes(field.id) ? (
        <>
          <span aria-hidden="true">••••••</span>
          <span className="visually-hidden">guardado</span>
        </>
      ) : null;
    }
    return <FieldValueView field={field} value={item.fields[field.id]} nameOf={nameOf} />;
  };

  return (
    <>
      <details className="table-columns">
        <summary>Escolher colunas</summary>
        <fieldset className="ticks">
          <legend className="visually-hidden">Colunas da tabela</legend>
          {everyColumn.map((id) => (
            <label key={id} className="tick">
              <input
                type="checkbox"
                checked={chosen.includes(id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? everyColumn.filter((one) => one === id || chosen.includes(one))
                    : chosen.filter((one) => one !== id);
                  onColumns(next);
                }}
              />
              {nameOfColumn(id)}
            </label>
          ))}
        </fieldset>
      </details>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {header('item', 'Item', 'title')}
              {chosen.map((id) => header(id, nameOfColumn(id), sortKeyOf(id)))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <th scope="row">
                  <button
                    type="button"
                    className="card-title"
                    onClick={() => {
                      setOpenId(item.id);
                    }}
                  >
                    {item.title}
                  </button>
                </th>
                {chosen.map((id) => (
                  <td key={id}>{cell(item, id)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length === 0 ? <p className="field-note">Nenhum item.</p> : null}
      {opened !== undefined ? (
        <ItemDialog
          item={opened}
          onClose={() => {
            setOpenId(null);
          }}
          {...panel}
        />
      ) : null}
    </>
  );
}
