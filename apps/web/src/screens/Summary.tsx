import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, type CustomField, type ListSummary, type Stage } from '../api.js';
import { formatDuration } from '../labels.js';
import { describeError } from '../messages.js';
import { Notice } from '../ui/kit.js';

/*
 * The numbers of a list. The server counts only what this person sees, so a
 * person who sees only their own items reads the numbers of their own items.
 * Every number is written out; the bars only help compare them.
 */

interface Row {
  key: string;
  label: string;
  count: number;
  note?: string;
}

const share = (count: number, total: number): string =>
  total === 0 ? '0%' : `${String(Math.round((count / total) * 100))}%`;

function Bars({ title, rows, total }: { title: string; rows: Row[]; total: number }): ReactNode {
  const most = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="summary-block" aria-label={title}>
      <h2>{title}</h2>
      <table className="summary-bars">
        <thead className="visually-hidden">
          <tr>
            <th scope="col">Nome</th>
            <th scope="col">Itens</th>
            <th scope="col">Parte do total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                {row.label}
                {row.note === undefined ? null : <span className="summary-note">{row.note}</span>}
              </th>
              <td className="summary-count">{row.count}</td>
              <td>
                <div className="summary-share">
                  <span className="summary-track" aria-hidden="true">
                    {row.count > 0 ? (
                      <span
                        className="summary-bar"
                        style={{ width: `${String((row.count / most) * 100)}%` }}
                      />
                    ) : null}
                  </span>
                  <span>{share(row.count, total)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** "Em média 2 horas", or what is known when nothing has left the stage yet. */
export function stayNote(averageSeconds: number | null, stays: number): string {
  if (averageSeconds === null || stays === 0) return 'ninguém saiu desta etapa em 90 dias';
  const times = stays === 1 ? '1 passagem' : `${String(stays)} passagens`;
  return `fica em média ${formatDuration(averageSeconds * 1000)} (${times} em 90 dias)`;
}

/**
 * The panel of a list. `compact` keeps the counts and the stages, for a list
 * pinned on the start page beside others.
 */
export function Summary({
  listId,
  stages,
  fields,
  seesAll,
  compact = false,
}: {
  listId: string;
  stages: Stage[];
  fields: CustomField[];
  seesAll: boolean;
  compact?: boolean;
}): ReactNode {
  const summary = useQuery({
    queryKey: ['summary', listId],
    queryFn: () => api.listSummary(listId),
  });
  if (summary.isPending) return <p className="muted">Contando…</p>;
  if (summary.isError) return <Notice tone="error">{describeError(summary.error)}</Notice>;
  const data: ListSummary = summary.data;
  const open = data.total - data.finished;

  const byStage: Row[] = data.byStage.map((one) => ({
    key: one.stageId,
    label: stages.find((stage) => stage.id === one.stageId)?.name ?? 'Etapa',
    count: one.count,
    note: stayNote(one.averageSeconds, one.stays),
  }));
  const byAssignee: Row[] = data.byAssignee.map((one) => ({
    key: one.userId ?? 'ninguem',
    label: one.userId === null ? 'Sem responsável' : (one.name ?? 'Outra pessoa'),
    count: one.count,
  }));

  return (
    <div className={compact ? 'summary summary-compact' : 'summary'}>
      {seesAll ? null : <p className="muted">Os números contam só os itens que são seus.</p>}
      <dl className="summary-tiles">
        <div>
          <dt>Itens</dt>
          <dd>{data.total}</dd>
        </div>
        <div>
          <dt>Em aberto</dt>
          <dd>{open}</dd>
        </div>
        <div>
          <dt>Concluídos</dt>
          <dd>{data.finished}</dd>
        </div>
        <div className={data.overdue > 0 ? 'is-late' : undefined}>
          <dt>Atrasados</dt>
          <dd>{data.overdue}</dd>
        </div>
        <div>
          <dt>Vencem hoje</dt>
          <dd>{data.dueToday}</dd>
        </div>
      </dl>
      <Bars title="Por etapa" rows={byStage} total={data.total} />
      {compact ? null : <Bars title="Com quem" rows={byAssignee} total={data.total} />}
      {(compact ? [] : data.byField).map((one) => {
        const field = fields.find((candidate) => candidate.id === one.fieldId);
        if (field === undefined) return null;
        const rows: Row[] = one.options.map((option) => ({
          key: option.optionId ?? 'sem-valor',
          label:
            option.optionId === null
              ? 'Sem valor'
              : (field.config.options?.find((candidate) => candidate.id === option.optionId)
                  ?.name ?? 'Opção arquivada'),
          count: option.count,
        }));
        return (
          <Bars key={one.fieldId} title={`Por ${field.name}`} rows={rows} total={data.total} />
        );
      })}
    </div>
  );
}
