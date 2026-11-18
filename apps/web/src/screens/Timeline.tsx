import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Item, Stage } from '../api.js';
import { isoDay } from '../calendar.js';
import { addDays, barIn, spanOf, weekStart, windowDays } from '../timeline.js';
import { Button, Select } from '../ui/kit.js';
import { ItemDialog, type PanelProps } from './Board.js';

/** Six weeks at a time: enough to plan a month and see what spills over. */
const DAYS = 42;
const SHORT_MONTH = new Intl.DateTimeFormat('pt-BR', { month: 'short' });
const LONG_DAY = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });
const dateOf = (day: string): Date => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
};

/*
 * The list as a timeline: one row per item, a bar from its start to its end
 * date, colored by its stage. The titles stay in place while the days scroll
 * sideways, on a phone too.
 */
export function Timeline({
  stages,
  items,
  ...panel
}: PanelProps & { stages: Stage[]; items: Item[] }): ReactNode {
  const dateFields = panel.fields.filter(
    (field) => field.kind === 'date' || field.kind === 'datetime',
  );
  const [startId, setStartId] = useState(dateFields[0]?.id ?? '');
  const [endId, setEndId] = useState(dateFields[1]?.id ?? dateFields[0]?.id ?? '');
  const today = isoDay(new Date());
  const [first, setFirst] = useState(addDays(weekStart(today), -7));
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = items.find((item) => item.id === openId);
  const start = dateFields.find((field) => field.id === startId) ?? dateFields[0];
  const end = dateFields.find((field) => field.id === endId) ?? start;

  if (!start || !end) {
    return (
      <p className="lead">
        Esta lista ainda não tem campos de data. Com um campo de início e outro de fim (em “Editar
        campos”), cada item vira uma barra aqui.
      </p>
    );
  }
  const days = windowDays(first, DAYS);
  const rows = items.map((item) => ({ item, span: spanOf(item, start, end) }));
  const dated = rows.filter((row) => row.span !== null);
  const undated = rows.filter((row) => row.span === null).map((row) => row.item);
  const grid = { '--dias': String(DAYS) } as CSSProperties;
  const choices = dateFields.map((field) => ({ value: field.id, label: field.name }));

  return (
    <>
      <div className="calendar-bar">
        <div className="list-tools-row">
          <Select label="Começa em" value={start.id} onChange={setStartId} options={choices} />
          <Select label="Termina em" value={end.id} onChange={setEndId} options={choices} />
        </div>
        <div className="calendar-nav">
          <Button
            variant="quiet"
            onClick={() => {
              setFirst(addDays(first, -28));
            }}
          >
            Semanas anteriores
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setFirst(addDays(first, 28));
            }}
          >
            Próximas semanas
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setFirst(addDays(weekStart(today), -7));
            }}
          >
            Voltar para hoje
          </Button>
        </div>
      </div>
      <div className="timeline-wrap">
        <div className="timeline" style={grid} role="table" aria-label="Linha do tempo">
          <div className="timeline-row timeline-head" role="row">
            <span className="timeline-title" role="columnheader">
              Item
            </span>
            {days.map((day, index) => {
              const date = dateOf(day);
              const monthStarts = date.getDate() === 1 || index === 0;
              return (
                <span
                  key={day}
                  role="columnheader"
                  aria-label={LONG_DAY.format(date)}
                  className={[
                    'timeline-day',
                    day === today ? 'is-today' : '',
                    date.getDay() === 0 || date.getDay() === 6 ? 'is-weekend' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {monthStarts ? (
                    <span className="timeline-month">{SHORT_MONTH.format(date)}</span>
                  ) : null}
                  {date.getDate()}
                </span>
              );
            })}
          </div>
          {dated.map(({ item, span }) => {
            const bar = span === null ? null : barIn(span, first, DAYS);
            const stage = stages.find((candidate) => candidate.id === item.stageId);
            return (
              <div key={item.id} className="timeline-row" role="row">
                <span className="timeline-title" role="rowheader">
                  <button
                    type="button"
                    className="card-title"
                    onClick={() => {
                      setOpenId(item.id);
                    }}
                  >
                    {item.title}
                  </button>
                </span>
                {bar !== null && span !== null ? (
                  <span
                    role="cell"
                    className="timeline-cell"
                    style={{ gridColumn: `${bar.column + 2} / span ${bar.days}` }}
                  >
                    <button
                      type="button"
                      className={[
                        'timeline-bar',
                        bar.clippedStart ? 'is-clipped-start' : '',
                        bar.clippedEnd ? 'is-clipped-end' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ '--cor': stage?.color ?? 'var(--marca)' } as CSSProperties}
                      onClick={() => {
                        setOpenId(item.id);
                      }}
                    >
                      {/* Too short a bar to read the dates: they are still there for screen readers. */}
                      <span className={bar.days >= 4 ? undefined : 'visually-hidden'}>
                        {span.start === span.end
                          ? LONG_DAY.format(dateOf(span.start))
                          : `${LONG_DAY.format(dateOf(span.start))} a ${LONG_DAY.format(dateOf(span.end))}`}
                      </span>
                      <span className="visually-hidden">, {item.title}</span>
                    </button>
                  </span>
                ) : (
                  <span role="cell" className="timeline-outside">
                    fora destas semanas
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {dated.length === 0 ? (
        <p className="field-note">
          Nenhum item com {start.name} ou {end.name} preenchido.
        </p>
      ) : null}
      {undated.length > 0 ? (
        <details className="calendar-undated">
          <summary>{undated.length === 1 ? '1 item' : `${undated.length} itens`} sem datas</summary>
          <ul className="calendar-items">
            {undated.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="calendar-item"
                  onClick={() => {
                    setOpenId(item.id);
                  }}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
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
