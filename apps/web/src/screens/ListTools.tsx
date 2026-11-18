import { useId, useState, type ReactNode } from 'react';
import type { CustomField, Stage } from '../api.js';
import { PRIORITY_NAMES, priorityLabel } from '../due.js';
import { parseDecimal } from '../fieldvalues.js';
import {
  isFiltering,
  NO_FILTER,
  DEFAULT_SORT,
  testsFor,
  type DueFilter,
  type FieldTest,
  type Filter,
  type GroupBy,
  type Sort,
  type SortKey,
} from '../filters.js';
import { Button, Select } from '../ui/kit.js';

const TEST_NAMES: Record<FieldTest['op'], string> = {
  is: 'é',
  contains: 'contém',
  atLeast: 'pelo menos',
  atMost: 'no máximo',
  from: 'a partir de',
  until: 'até',
  filled: 'está preenchido',
  empty: 'está vazio',
};

/** Fields an order makes sense for: not secrets, files or long texts. */
const sortable = (field: CustomField): boolean =>
  field.kind !== 'secret' && field.kind !== 'files' && field.kind !== 'long_text';

/** A fresh test of the given kind, with an empty value where one is needed. */
function blankTest(op: FieldTest['op']): FieldTest {
  if (op === 'filled' || op === 'empty') return { op };
  if (op === 'atLeast' || op === 'atMost') return { op, value: 0 };
  return { op, value: '' };
}

/*
 * The bar above a list or a board: search, who, stage, one field, and the
 * order. It only narrows what the person already sees.
 */
const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: 'any', label: 'Qualquer prazo' },
  { value: 'overdue', label: 'Atrasados' },
  { value: 'today', label: 'Vencem hoje' },
  { value: 'week', label: 'Próximos 7 dias' },
  { value: 'none', label: 'Sem prazo' },
];

export function ListTools({
  filter,
  sort,
  onChange,
  stages,
  fields,
  people,
  shown,
  total,
  group,
  onGroup,
}: {
  filter: Filter;
  sort: Sort;
  onChange: (filter: Filter, sort: Sort) => void;
  /** How the list view gathers items; null in views that do not group. */
  group: GroupBy | null;
  onGroup: (group: GroupBy) => void;
  stages: Stage[];
  fields: CustomField[];
  /** People that can be picked as "who": those on the items, by name. */
  people: { id: string; name: string }[];
  shown: number;
  total: number;
}): ReactNode {
  const searchId = useId();
  const valueId = useId();
  const field = fields.find((candidate) => candidate.id === filter.field?.id);
  const test = filter.field?.test;
  const setFilter = (next: Partial<Filter>): void => {
    onChange({ ...filter, ...next }, sort);
  };
  const setTest = (next: FieldTest): void => {
    if (field) setFilter({ field: { id: field.id, test: next } });
  };

  let valueInput: ReactNode = null;
  if (field && test && 'value' in test) {
    if (test.op === 'is') {
      const choices =
        field.kind === 'people'
          ? people.map((person) => ({ value: person.id, label: person.name }))
          : (field.config.options ?? [])
              .filter((option) => option.archived !== true)
              .map((option) => ({ value: option.id, label: option.name }));
      valueInput = (
        <Select
          label={`Valor de ${field.name}`}
          value={test.value}
          onChange={(value) => {
            setTest({ op: 'is', value });
          }}
          options={[{ value: '', label: 'Escolha' }, ...choices]}
        />
      );
    } else if (test.op === 'atLeast' || test.op === 'atMost') {
      const op = test.op;
      valueInput = (
        <NumberInput
          key={`${field.id}-${op}`}
          label={`Valor de ${field.name}`}
          initial={test.value}
          onNumber={(value) => {
            setTest({ op, value });
          }}
        />
      );
    } else {
      const op = test.op;
      valueInput = (
        <div className="field">
          <label htmlFor={valueId}>Valor de {field.name}</label>
          <input
            id={valueId}
            type={op === 'from' || op === 'until' ? 'date' : 'text'}
            value={test.value}
            maxLength={200}
            onChange={(event) => {
              setTest({ op, value: event.target.value });
            }}
          />
        </div>
      );
    }
  }

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'manual', label: 'Ordem do quadro' },
    { value: 'stage', label: 'Tempo na etapa' },
    { value: 'title', label: 'Título' },
    { value: 'priority', label: 'Prioridade' },
    { value: 'due', label: 'Prazo' },
    { value: 'start', label: 'Início' },
    { value: 'created', label: 'Criação' },
    { value: 'updated', label: 'Última mudança' },
    ...fields
      .filter(sortable)
      .map((candidate) => ({ value: `field:${candidate.id}` as SortKey, label: candidate.name })),
  ];

  return (
    <div className="list-tools" role="search" aria-label="Filtrar e ordenar">
      <div className="list-tools-row">
        <div className="field list-tools-search">
          <label htmlFor={searchId}>Buscar no título</label>
          <input
            id={searchId}
            type="search"
            value={filter.text}
            maxLength={200}
            onChange={(event) => {
              setFilter({ text: event.target.value });
            }}
          />
        </div>
        <Select
          label="Responsável"
          value={filter.who}
          onChange={(who) => {
            setFilter({ who });
          }}
          options={[
            { value: 'anyone', label: 'Qualquer pessoa' },
            { value: 'me', label: 'Comigo' },
            { value: 'nobody', label: 'Sem responsável' },
            ...people.map((person) => ({ value: person.id, label: person.name })),
          ]}
        />
        <Select
          label="Etapa"
          value={filter.stageId ?? ''}
          onChange={(stageId) => {
            setFilter({ stageId: stageId === '' ? null : stageId });
          }}
          options={[
            { value: '', label: 'Todas as etapas' },
            ...stages.map((stage) => ({ value: stage.id, label: stage.name })),
          ]}
        />
        <Select
          label="Ordenar por"
          value={sort.key}
          onChange={(key) => {
            onChange(filter, { ...sort, key });
          }}
          options={sortOptions}
        />
        {group !== null ? (
          <Select
            label="Agrupar por"
            value={group}
            onChange={onGroup}
            options={[
              { value: 'stage', label: 'Etapa' },
              { value: 'who', label: 'Responsável' },
              { value: 'priority', label: 'Prioridade' },
              ...fields
                .filter(
                  (candidate) =>
                    candidate.kind !== 'secret' &&
                    candidate.kind !== 'files' &&
                    candidate.kind !== 'long_text',
                )
                .map((candidate) => ({
                  value: `field:${candidate.id}` as GroupBy,
                  label: candidate.name,
                })),
              { value: 'none', label: 'Sem grupos' },
            ]}
          />
        ) : null}
        <Button
          variant="quiet"
          aria-pressed={sort.descending}
          onClick={() => {
            onChange(filter, { ...sort, descending: !sort.descending });
          }}
        >
          {sort.descending ? 'Ordem decrescente' : 'Ordem crescente'}
        </Button>
      </div>
      <div className="list-tools-row">
        <Select
          label="Prioridade"
          value={filter.priority}
          onChange={(priority) => {
            setFilter({ priority });
          }}
          options={[
            { value: 'any', label: 'Qualquer prioridade' },
            ...Object.keys(PRIORITY_NAMES).map((key) => ({
              value: key,
              label: priorityLabel(Number(key)) ?? key,
            })),
            { value: 'none', label: 'Sem prioridade' },
          ]}
        />
        <Select
          label="Prazo"
          value={filter.due}
          onChange={(due) => {
            setFilter({ due });
          }}
          options={DUE_OPTIONS}
        />
        <Select
          label="Filtrar por campo"
          value={field?.id ?? ''}
          onChange={(fieldId) => {
            const chosen = fields.find((candidate) => candidate.id === fieldId);
            setFilter({
              field: chosen
                ? { id: chosen.id, test: blankTest(testsFor(chosen.kind)[0] ?? 'filled') }
                : null,
            });
          }}
          options={[
            { value: '', label: 'Nenhum campo' },
            ...fields.map((candidate) => ({ value: candidate.id, label: candidate.name })),
          ]}
        />
        {field && test ? (
          <Select
            label={`Condição de ${field.name}`}
            value={test.op}
            onChange={(op) => {
              setTest(blankTest(op));
            }}
            options={testsFor(field.kind).map((op) => ({ value: op, label: TEST_NAMES[op] }))}
          />
        ) : null}
        {valueInput}
        {isFiltering(filter) || sort.key !== DEFAULT_SORT.key || sort.descending ? (
          <Button
            variant="quiet"
            onClick={() => {
              onChange(NO_FILTER, DEFAULT_SORT);
            }}
          >
            Limpar filtros e ordem
          </Button>
        ) : null}
      </div>
      <p className="field-note" role="status">
        {isFiltering(filter)
          ? `Mostrando ${shown} de ${total} ${total === 1 ? 'item' : 'itens'}.`
          : `${total} ${total === 1 ? 'item' : 'itens'}.`}
      </p>
    </div>
  );
}

/** A number as people here type it ("1.499,90"), passed on only once it reads as one. */
function NumberInput({
  label,
  initial,
  onNumber,
}: {
  label: string;
  initial: number;
  onNumber: (value: number) => void;
}): ReactNode {
  const id = useId();
  const [text, setText] = useState(initial === 0 ? '' : String(initial).replace('.', ','));
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        maxLength={30}
        onChange={(event) => {
          setText(event.target.value);
          const value = parseDecimal(event.target.value);
          if (value !== null) onNumber(value);
        }}
      />
    </div>
  );
}
