import { FIELD_KINDS, usesOptions, type FieldKind } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type CustomField, type FieldConfigDraft, type OptionDraft } from '../api.js';
import { CURRENCIES, FIELD_KIND_HINTS, FIELD_KIND_NAMES, OPTION_COLORS } from '../fieldvalues.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

const KIND_OPTIONS = FIELD_KINDS.map((value) => ({ value, label: FIELD_KIND_NAMES[value] }));
const RATING_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10].map((max) => ({
  value: String(max),
  label: `De 1 a ${max}`,
}));
/** How many fields the list view shows as columns; the rest are read by opening the item. */
export const FIELD_COLUMNS = 4;

interface OtherList {
  id: string;
  label: string;
}

/** Where whoever manages a list decides what it records about each item. */
export function FieldEditor({
  listId,
  fields,
  otherLists,
}: {
  listId: string;
  fields: CustomField[];
  otherLists: OtherList[];
}): ReactNode {
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['fields', listId] });
    await queryClient.invalidateQueries({ queryKey: ['items', listId] });
  }, [queryClient, listId]);
  const archived = useQuery({
    queryKey: ['fields', listId, 'archived'],
    queryFn: async () => (await api.fields(listId, { archived: true })).filter((f) => f.archived),
  });

  const move = useAction(
    useCallback(
      async (index: number, by: -1 | 1) => {
        const ids = fields.map((field) => field.id);
        const [moved] = ids.splice(index, 1);
        if (moved === undefined) return;
        ids.splice(index + by, 0, moved);
        await api.reorderFields(listId, ids);
        await refresh();
      },
      [fields, listId, refresh],
    ),
  );

  return (
    <section className="panel" aria-label="Campos desta lista">
      <h2>Campos desta lista</h2>
      <p className="lead">
        Os campos são o que esta lista anota sobre cada item, além do título. Os {FIELD_COLUMNS}{' '}
        primeiros aparecem como colunas; os demais, ao abrir o item.
      </p>
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
      {fields.length === 0 ? (
        <p className="field-note">Esta lista ainda não tem campos.</p>
      ) : (
        <ol className="stage-editor">
          {fields.map((field, index) => (
            <FieldRow
              // A saved field comes back with new options: start its form again from them.
              key={`${field.id}:${JSON.stringify(field.config)}:${field.name}`}
              field={field}
              onMove={(by) => {
                move.run(index, by);
              }}
              canMoveUp={index > 0 && !move.busy}
              canMoveDown={index < fields.length - 1 && !move.busy}
              onChanged={refresh}
            />
          ))}
        </ol>
      )}
      <AddField listId={listId} onAdded={refresh} />
      {otherLists.length > 0 ? (
        <CopyFields listId={listId} otherLists={otherLists} onCopied={refresh} />
      ) : null}
      {archived.isError ? <Notice tone="error">{describeError(archived.error)}</Notice> : null}
      {(archived.data ?? []).length > 0 ? (
        <div className="subsection">
          <h3>Campos arquivados</h3>
          <p className="field-note">
            Um campo arquivado some da lista, mas o que foi preenchido nele continua guardado.
          </p>
          <ul className="rows">
            {(archived.data ?? []).map((field) => (
              <ArchivedRow key={field.id} field={field} onChanged={refresh} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ArchivedRow({
  field,
  onChanged,
}: {
  field: CustomField;
  onChanged: () => Promise<void>;
}): ReactNode {
  const restore = useAction(
    useCallback(async () => {
      await api.updateField(field.id, { archived: false });
      await onChanged();
    }, [field.id, onChanged]),
  );
  return (
    <li>
      <span>
        {field.name}
        <span className="row-detail">{FIELD_KIND_NAMES[field.kind]}</span>
      </span>
      <Button variant="quiet" busy={restore.busy} onClick={restore.run}>
        Restaurar<span className="visually-hidden"> {field.name}</span>
      </Button>
      {restore.error ? <Notice tone="error">{restore.error}</Notice> : null}
    </li>
  );
}

interface OptionState {
  /** Stable while editing; the server's id once the option exists. */
  key: string;
  id: string | undefined;
  name: string;
  color: string;
  archived: boolean;
}

let nextKey = 0;
/** A blank option, in the next color after the `taken` ones. */
const newOption = (taken: number): OptionState => {
  nextKey += 1;
  return {
    key: `nova-${nextKey}`,
    id: undefined,
    name: '',
    color: OPTION_COLORS[taken % OPTION_COLORS.length] ?? '#9ba6b8',
    archived: false,
  };
};

const toDrafts = (options: OptionState[]): OptionDraft[] =>
  options
    .filter((option) => option.id !== undefined || option.name.trim() !== '')
    .map((option) => ({
      ...(option.id === undefined ? {} : { id: option.id }),
      name: option.name.trim(),
      color: option.color,
      ...(option.archived ? { archived: true } : {}),
    }));

function OptionsEditor({
  fieldName,
  options,
  onChange,
}: {
  fieldName: string;
  options: OptionState[];
  onChange: (options: OptionState[]) => void;
}): ReactNode {
  const patch = (key: string, change: Partial<OptionState>): void => {
    onChange(options.map((option) => (option.key === key ? { ...option, ...change } : option)));
  };
  return (
    <div className="options-editor">
      {options.map((option, index) => (
        <div key={option.key} className={option.archived ? 'option-row is-archived' : 'option-row'}>
          <Field
            label={`Opção ${index + 1} de ${fieldName}`}
            value={option.name}
            maxLength={60}
            disabled={option.archived}
            onChange={(event) => {
              patch(option.key, { name: event.target.value });
            }}
          />
          <Field
            label={`Cor da opção ${index + 1}`}
            type="color"
            value={option.color}
            disabled={option.archived}
            onChange={(event) => {
              patch(option.key, { color: event.target.value });
            }}
          />
          {option.id === undefined ? (
            <Button
              variant="quiet"
              onClick={() => {
                onChange(options.filter((other) => other.key !== option.key));
              }}
            >
              Tirar<span className="visually-hidden"> opção {index + 1}</span>
            </Button>
          ) : (
            <Button
              variant="quiet"
              onClick={() => {
                patch(option.key, { archived: !option.archived });
              }}
            >
              {option.archived ? 'Voltar a usar' : 'Arquivar'}
              <span className="visually-hidden"> {option.name}</span>
            </Button>
          )}
        </div>
      ))}
      <Button
        variant="quiet"
        onClick={() => {
          onChange([...options, newOption(options.length)]);
        }}
      >
        Adicionar opção<span className="visually-hidden"> em {fieldName}</span>
      </Button>
    </div>
  );
}

function FieldRow({
  field,
  onMove,
  canMoveUp,
  canMoveDown,
  onChanged,
}: {
  field: CustomField;
  onMove: (by: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(field.name);
  const [currency, setCurrency] = useState(field.config.currency ?? 'BRL');
  const [options, setOptions] = useState<OptionState[]>(() =>
    (field.config.options ?? []).map((option) => ({
      key: option.id,
      id: option.id,
      name: option.name,
      color: option.color,
      archived: option.archived === true,
    })),
  );

  const before = JSON.stringify(
    (field.config.options ?? []).map((option) => ({
      id: option.id,
      name: option.name,
      color: option.color,
      ...(option.archived === true ? { archived: true } : {}),
    })),
  );
  const optionsChanged = usesOptions(field.kind) && JSON.stringify(toDrafts(options)) !== before;
  const currencyChanged = field.kind === 'money' && currency !== (field.config.currency ?? 'BRL');
  const changed = name.trim() !== field.name || optionsChanged || currencyChanged;
  const unnamed = options.some((option) => option.id !== undefined && option.name.trim() === '');

  const save = useAction(
    useCallback(async () => {
      const config: FieldConfigDraft | undefined = optionsChanged
        ? { options: toDrafts(options) }
        : currencyChanged
          ? { currency }
          : undefined;
      await api.updateField(field.id, {
        ...(name.trim() !== field.name ? { name: name.trim() } : {}),
        ...(config ? { config } : {}),
      });
      await onChanged();
    }, [field.id, field.name, name, options, optionsChanged, currency, currencyChanged, onChanged]),
  );
  const archive = useAction(
    useCallback(async () => {
      await api.updateField(field.id, { archived: true });
      await onChanged();
    }, [field.id, onChanged]),
  );

  const currencies = CURRENCIES.some((each) => each.value === currency)
    ? CURRENCIES
    : [...CURRENCIES, { value: currency, label: currency }];

  return (
    <li>
      <div className="field-fields">
        <Field
          label="Nome do campo"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={60}
        />
        <div className="field">
          <span className="field-label">Tipo</span>
          <p className="fixed-value">
            {FIELD_KIND_NAMES[field.kind]}
            {field.kind === 'rating' ? `, de 1 a ${field.config.max ?? 5}` : ''}
          </p>
        </div>
        {field.kind === 'money' ? (
          <Select label="Moeda" value={currency} onChange={setCurrency} options={currencies} />
        ) : null}
      </div>
      {usesOptions(field.kind) ? (
        <OptionsEditor fieldName={field.name} options={options} onChange={setOptions} />
      ) : null}
      <div className="actions">
        <Button
          variant="quiet"
          busy={save.busy}
          disabled={!changed || name.trim() === '' || unnamed}
          onClick={save.run}
        >
          Salvar campo<span className="visually-hidden"> {field.name}</span>
        </Button>
        <Button
          variant="quiet"
          disabled={!canMoveUp}
          onClick={() => {
            onMove(-1);
          }}
        >
          Subir<span className="visually-hidden"> {field.name}</span>
        </Button>
        <Button
          variant="quiet"
          disabled={!canMoveDown}
          onClick={() => {
            onMove(1);
          }}
        >
          Descer<span className="visually-hidden"> {field.name}</span>
        </Button>
        <Button variant="quiet" busy={archive.busy} onClick={archive.run}>
          Arquivar campo<span className="visually-hidden"> {field.name}</span>
        </Button>
      </div>
      {(save.error ?? archive.error) ? (
        <Notice tone="error">{save.error ?? archive.error}</Notice>
      ) : null}
    </li>
  );
}

function AddField({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FieldKind>('text');
  const [currency, setCurrency] = useState('BRL');
  const [max, setMax] = useState('5');
  const [options, setOptions] = useState<OptionState[]>(() => [newOption(0), newOption(1)]);
  const add = useAction(
    useCallback(async () => {
      const config: FieldConfigDraft | undefined = usesOptions(kind)
        ? { options: toDrafts(options) }
        : kind === 'money'
          ? { currency }
          : kind === 'rating'
            ? { max: Number(max) }
            : undefined;
      await api.createField(listId, { name: name.trim(), kind, ...(config ? { config } : {}) });
      setName('');
      setOptions([newOption(0), newOption(1)]);
      await onAdded();
    }, [listId, name, kind, currency, max, options, onAdded]),
  );
  return (
    <Form onSubmit={add.run}>
      <h3>Novo campo</h3>
      <div className="field-fields">
        <Field
          label="Nome do novo campo"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={60}
        />
        <Select label="Tipo do novo campo" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        {kind === 'money' ? (
          <Select
            label="Moeda do novo campo"
            value={currency}
            onChange={setCurrency}
            options={CURRENCIES}
          />
        ) : null}
        {kind === 'rating' ? (
          <Select label="Escala da nota" value={max} onChange={setMax} options={RATING_OPTIONS} />
        ) : null}
      </div>
      <p className="field-note">
        {FIELD_KIND_HINTS[kind]} O tipo não muda depois que o campo é criado.
      </p>
      {usesOptions(kind) ? (
        <OptionsEditor fieldName="novo campo" options={options} onChange={setOptions} />
      ) : null}
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
      <Button type="submit" busy={add.busy} disabled={name.trim() === ''}>
        Adicionar campo
      </Button>
    </Form>
  );
}

function CopyFields({
  listId,
  otherLists,
  onCopied,
}: {
  listId: string;
  otherLists: OtherList[];
  onCopied: () => Promise<void>;
}): ReactNode {
  const guard = useGuard();
  const [from, setFrom] = useState(otherLists[0]?.id ?? '');
  const [result, setResult] = useState<string | null>(null);
  const copy = useAction(
    useCallback(async () => {
      setResult(null);
      // Copying from a sensitive list asks for the authenticator code first.
      const { created, skipped } = await guard(() => api.copyFields(listId, from));
      const parts = [
        created.length === 0
          ? 'Nenhum campo novo para copiar.'
          : `Copiados: ${created.map((field) => field.name).join(', ')}.`,
        skipped.length === 0 ? '' : `Esta lista já tinha: ${skipped.join(', ')}.`,
      ];
      setResult(parts.filter((part) => part !== '').join(' '));
      await onCopied();
    }, [guard, listId, from, onCopied]),
  );
  return (
    <div className="subsection">
      <h3>Copiar campos de outra lista</h3>
      <p className="field-note">
        Os campos copiados contam como o mesmo campo nas duas listas, o que permite somar e comparar
        entre elas.
      </p>
      <div className="copy-from">
        <Select
          label="Copiar os campos de"
          value={from}
          onChange={setFrom}
          options={otherLists.map((list) => ({ value: list.id, label: list.label }))}
        />
      </div>
      {copy.error ? <Notice tone="error">{copy.error}</Notice> : null}
      {result !== null ? <Notice tone="ok">{result}</Notice> : null}
      <Button variant="quiet" busy={copy.busy} disabled={from === ''} onClick={copy.run}>
        Copiar campos
      </Button>
    </div>
  );
}
