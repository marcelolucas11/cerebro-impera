import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type ReportTotals, type WeeklyReport } from '../api.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { change, TOTAL_NAMES, weekLabel } from '../reports.js';
import { Link, listPath } from '../router.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, Select, useAction } from '../ui/kit.js';

/*
 * The weekly report: what came in, what was finished, what is open and what is
 * late, per list and per person, against the week before. The routine writes
 * it at the start of Monday; each reader sees the lists where they see every
 * item, and the sensitive ones after the code.
 */
export function Reports({ isOwner }: { isOwner: boolean }): ReactNode {
  const weeks = useQuery({ queryKey: ['reports'], queryFn: api.reports });
  const [chosen, setChosen] = useState<string | null>(null);

  if (weeks.isPending) return <p className="lead">Abrindo…</p>;
  if (weeks.isError) return <Notice tone="error">{describeError(weeks.error)}</Notice>;
  const current = weeks.data.find((week) => week.id === chosen) ?? weeks.data[0];

  return (
    <div className="report">
      <h1>Relatório da semana</h1>
      <p className="lead">
        De segunda a domingo, contado no começo da segunda-feira, quando a semana fecha.
        {isOwner ? null : ' Mostra só as listas em que você vê todos os itens.'}
      </p>
      {current === undefined ? (
        <p className="muted">
          O primeiro relatório sai na próxima segunda-feira, com a semana que terminou.
        </p>
      ) : (
        <>
          <div className="report-pick">
            <Select
              label="Semana"
              value={current.id}
              options={weeks.data.map((week) => ({
                value: week.id,
                label: weekLabel(week.weekStart),
              }))}
              onChange={setChosen}
            />
          </div>
          <WeekReport id={current.id} />
        </>
      )}
    </div>
  );
}

function WeekReport({ id }: { id: string }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const report = useQuery({ queryKey: ['report', id], queryFn: () => api.report(id) });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  const unlock = useAction(
    useCallback(async () => {
      const whole = await guard(() => api.report(id, true));
      queryClient.setQueryData(['report', id], whole);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    }, [guard, id, queryClient]),
  );

  if (report.isPending) return <p className="muted">Abrindo o relatório…</p>;
  if (report.isError) return <Notice tone="error">{describeError(report.error)}</Notice>;
  const data: WeeklyReport = report.data;
  // Sensitive lists this person sees in full are left out until the code is confirmed.
  const heldBack =
    me.data?.stepUp === false &&
    (tree.data?.lists.some((list) => list.isSensitive && list.itemScope === 'all') ?? false);

  return (
    <>
      <p className="muted">{`Feito em ${formatWhen(data.madeAt)}.`}</p>
      {heldBack ? (
        <div className="report-locked">
          <p className="muted">As listas sensíveis ficam de fora até você confirmar o código.</p>
          {unlock.error ? <Notice tone="error">{unlock.error}</Notice> : null}
          <Button variant="quiet" onClick={unlock.run} busy={unlock.busy}>
            Incluir as listas sensíveis
          </Button>
        </div>
      ) : null}
      <Totals totals={data.totals} previous={data.previous} />

      <section className="report-block" aria-labelledby="report-lists">
        <h2 id="report-lists">Por lista</h2>
        {data.lists.length === 0 ? (
          <p className="muted">Nenhuma lista teve movimento nem itens em aberto.</p>
        ) : (
          <div className="report-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Lista</th>
                  {TOTAL_NAMES.map((total) => (
                    <th scope="col" key={total.key}>
                      {total.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.lists.map((line) => (
                  <tr key={line.listId}>
                    <th scope="row">
                      <Link to={listPath(line.listId, 'summary')} current={false}>
                        {line.listName}
                      </Link>
                      <span className="row-detail">{line.spaceName}</span>
                    </th>
                    {TOTAL_NAMES.map((total) => (
                      <td key={total.key} className={late(total.key, line[total.key])}>
                        {line[total.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="report-block" aria-labelledby="report-people">
        <h2 id="report-people">Por pessoa</h2>
        {data.people.length === 0 ? (
          <p className="muted">Ninguém tinha itens nessas listas.</p>
        ) : (
          <div className="report-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Pessoa</th>
                  <th scope="col">Concluídos</th>
                  <th scope="col">Em aberto</th>
                  <th scope="col">Atrasados</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((person) => (
                  <tr key={person.userId}>
                    <th scope="row">{person.name ?? 'Outra pessoa'}</th>
                    <td>{person.finished}</td>
                    <td>{person.open}</td>
                    <td className={late('overdue', person.overdue)}>{person.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** Late is said by the column; the mark only draws the eye to it. */
const late = (key: keyof ReportTotals, count: number): string | undefined =>
  key === 'overdue' && count > 0 ? 'is-late' : undefined;

function Totals({
  totals,
  previous,
}: {
  totals: ReportTotals;
  previous: ReportTotals | null;
}): ReactNode {
  return (
    <dl className="summary-tiles report-tiles">
      {TOTAL_NAMES.map((total) => {
        const moved = change(totals[total.key], previous === null ? null : previous[total.key]);
        return (
          <div key={total.key} className={late(total.key, totals[total.key])}>
            <dt>{total.label}</dt>
            <dd>
              {totals[total.key]}
              {moved === null ? null : <span className="report-change">{moved}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
