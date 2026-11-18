import { useState, type ReactNode } from 'react';
import type { Item } from '../api.js';
import {
  isoDay,
  itemsByDay,
  monthGrid,
  monthName,
  monthOf,
  shiftMonth,
  WEEKDAYS,
} from '../calendar.js';
import { Button, Select } from '../ui/kit.js';
import { ItemDialog, type PanelProps } from './Board.js';

const DAY_NAME = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dayName = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return DAY_NAME.format(new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1));
};

/*
 * The list as a month: each item on the day of one of its date fields. On a
 * phone the grid becomes an agenda, only the days that have something.
 */
export function Calendar({ items, ...panel }: PanelProps & { items: Item[] }): ReactNode {
  const dateFields = panel.fields.filter(
    (field) => field.kind === 'date' || field.kind === 'datetime',
  );
  const [fieldId, setFieldId] = useState(dateFields[0]?.id ?? '');
  const field = dateFields.find((candidate) => candidate.id === fieldId) ?? dateFields[0];
  const today = isoDay(new Date());
  const [month, setMonth] = useState(monthOf(today));
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = items.find((item) => item.id === openId);

  if (!field) {
    return (
      <p className="lead">
        Esta lista ainda não tem um campo de data. Quem gerencia a lista pode criar um em “Editar
        campos”, e os itens passam a aparecer aqui no dia escolhido.
      </p>
    );
  }
  const { byDay, undated } = itemsByDay(items, field);
  const days = monthGrid(month);
  const inThisMonth = days.some((day) => day.inMonth && (byDay.get(day.date)?.length ?? 0) > 0);
  const open = (item: Item): ReactNode => (
    <button
      type="button"
      className="calendar-item"
      onClick={() => {
        setOpenId(item.id);
      }}
    >
      {item.title}
    </button>
  );

  return (
    <>
      <div className="calendar-bar">
        {dateFields.length > 1 ? (
          <Select
            label="Datas de"
            value={field.id}
            onChange={setFieldId}
            options={dateFields.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            }))}
          />
        ) : (
          <p className="muted">Pelo campo {field.name}</p>
        )}
        <div className="calendar-nav">
          <Button
            variant="quiet"
            onClick={() => {
              setMonth(shiftMonth(month, -1));
            }}
          >
            Mês anterior
          </Button>
          <h2 className="calendar-month" aria-live="polite">
            {monthName(month)}
          </h2>
          <Button
            variant="quiet"
            onClick={() => {
              setMonth(shiftMonth(month, 1));
            }}
          >
            Próximo mês
          </Button>
          {month !== monthOf(today) ? (
            <Button
              variant="quiet"
              onClick={() => {
                setMonth(monthOf(today));
              }}
            >
              Voltar para hoje
            </Button>
          ) : null}
        </div>
      </div>
      <div className="calendar-head" aria-hidden="true">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday.slice(0, 3)}</span>
        ))}
      </div>
      <ol className="calendar" aria-label={`Itens de ${monthName(month)}`}>
        {days.map((day) => {
          const list = byDay.get(day.date) ?? [];
          const classes = [
            'calendar-day',
            day.inMonth ? '' : 'is-outside',
            list.length === 0 ? 'is-empty' : '',
            day.date === today ? 'is-today' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={day.date} className={classes}>
              <span className="calendar-day-number" aria-hidden="true">
                {Number(day.date.slice(8))}
              </span>
              <span className="calendar-day-name">
                {dayName(day.date)}
                {day.date === today ? ', hoje' : ''}
              </span>
              {list.length > 0 ? (
                <ul className="calendar-items">
                  {list.map((item) => (
                    <li key={item.id}>{open(item)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!inThisMonth ? (
        <p className="field-note calendar-nothing">Nenhum item com data neste mês.</p>
      ) : null}
      {undated.length > 0 ? (
        <details className="calendar-undated">
          <summary>
            {undated.length === 1 ? '1 item' : `${undated.length} itens`} sem {field.name}
          </summary>
          <ul className="calendar-items">
            {undated.map((item) => (
              <li key={item.id}>{open(item)}</li>
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
