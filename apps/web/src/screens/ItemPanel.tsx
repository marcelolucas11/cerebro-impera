import type { FieldValue } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { api, type CustomField, type Item, type ItemChange } from '../api.js';
import { draftOf, sameValue, valueOf, type FieldDraft } from '../fieldvalues.js';
import { describeChange } from '../history.js';
import { formatDuration, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';
import { FieldInput, FieldValueView } from './FieldInput.js';

/** One item opened in place: what it says, what its list records about it, and every stage it has been through. */
export function ItemPanel({
  item,
  fields,
  canEdit,
  nameOf,
  listNameOf,
}: {
  item: Item;
  fields: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
}): ReactNode {
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const history = useQuery({
    // Re-read whenever the item changes stage.
    queryKey: ['stage-history', item.id, item.stageSince],
    queryFn: () => api.stageHistory(item.id),
  });

  // What each field would be saved as, or what is wrong with what was typed.
  const parsed = fields.map((field) => {
    const draft = drafts[field.id] ?? draftOf(field, item.fields[field.id]);
    const touched = field.id in drafts;
    const result = touched ? valueOf(field, draft, item.fields[field.id]) : null;
    return { field, draft, result };
  });
  const fieldChanges: Record<string, FieldValue | null> = {};
  for (const { field, result } of parsed) {
    if (result?.ok && !sameValue(result.value, item.fields[field.id])) {
      fieldChanges[field.id] = result.value;
    }
  }
  const invalid = parsed.some(({ result }) => result !== null && !result.ok);
  const changed =
    title.trim() !== item.title ||
    description !== item.description ||
    Object.keys(fieldChanges).length > 0;

  const save = useAction(
    useCallback(
      async (input: Parameters<typeof api.updateItem>[1]) => {
        await api.updateItem(item.id, input);
        setDrafts({});
        await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      },
      [item.id, item.listId, queryClient],
    ),
  );
  const submit = (): void => {
    save.run({
      ...(title.trim() !== item.title ? { title: title.trim() } : {}),
      ...(description !== item.description ? { description } : {}),
      ...(Object.keys(fieldChanges).length > 0 ? { fields: fieldChanges } : {}),
    });
  };

  return (
    <div className="item-panel">
      {canEdit ? (
        <Form onSubmit={submit}>
          <Field
            label="Título"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            maxLength={500}
          />
          <div className="field">
            <label htmlFor={descriptionId}>Descrição</label>
            <textarea
              id={descriptionId}
              rows={4}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              maxLength={50_000}
            />
          </div>
          {parsed.length > 0 ? (
            <div className="item-fields">
              {parsed.map(({ field, draft, result }) => (
                <FieldInput
                  key={field.id}
                  field={field}
                  draft={draft}
                  previous={item.fields[field.id]}
                  error={result !== null && !result.ok ? result.message : null}
                  onChange={(next) => {
                    setDrafts((current) => ({ ...current, [field.id]: next }));
                  }}
                />
              ))}
            </div>
          ) : null}
          {save.error ? <Notice tone="error">{save.error}</Notice> : null}
          <Button
            type="submit"
            busy={save.busy}
            disabled={!changed || invalid || title.trim() === ''}
          >
            Salvar item
          </Button>
        </Form>
      ) : (
        <>
          <p className="item-description">{item.description || 'Sem descrição.'}</p>
          {fields.length > 0 ? (
            <dl className="item-facts">
              {fields.map((field) => (
                <div key={field.id}>
                  <dt>{field.name}</dt>
                  <dd>
                    <FieldValueView field={field} value={item.fields[field.id]} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
      <div className="subsection">
        <h3>Tempo em cada etapa</h3>
        {history.isError ? <Notice tone="error">{describeError(history.error)}</Notice> : null}
        <ol className="stays">
          {(history.data ?? []).map((stay) => {
            const from = Date.parse(stay.enteredAt);
            const until = stay.leftAt === null ? Date.now() : Date.parse(stay.leftAt);
            return (
              <li key={stay.enteredAt}>
                <span>
                  {stay.stageName}
                  {stay.leftAt === null ? <span className="tag">etapa atual</span> : null}
                </span>
                <span className="muted">
                  {formatDuration(until - from)}
                  {stay.leftAt === null ? ' até agora' : ''}, desde {formatWhen(stay.enteredAt)},
                  por {nameOf(stay.movedBy)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <ItemHistory
        // What the item is now is part of the key: a change made here shows up at once.
        key={item.updatedAt}
        item={item}
        fields={fields}
        nameOf={nameOf}
        listNameOf={listNameOf}
      />
    </div>
  );
}

const PAGE = 50;

/** Everything that was done to the item, newest first. Loaded only when asked for. */
function ItemHistory({
  item,
  fields,
  nameOf,
  listNameOf,
}: {
  item: Item;
  fields: CustomField[];
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [older, setOlder] = useState<ItemChange[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const latest = useQuery({
    queryKey: ['item-history', item.id, item.updatedAt],
    queryFn: () => api.itemHistory(item.id),
    enabled: open,
  });
  const changes = [...(latest.data ?? []), ...older];
  const lastId = changes.at(-1)?.id;
  const more = useAction(
    useCallback(async () => {
      if (lastId === undefined) return;
      const page = await api.itemHistory(item.id, lastId);
      setOlder((current) => [...current, ...page]);
      if (page.length < PAGE) setExhausted(true);
    }, [item.id, lastId]),
  );
  const context = {
    nameOf,
    listNameOf,
    fieldOf: (fieldId: string) => fields.find((field) => field.id === fieldId),
  };
  const mayHaveMore = (latest.data?.length ?? 0) === PAGE && !exhausted;

  return (
    <div className="subsection">
      <h3>Histórico</h3>
      {!open ? (
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(true);
          }}
        >
          Ver o que mudou neste item
        </Button>
      ) : null}
      {latest.isError ? <Notice tone="error">{describeError(latest.error)}</Notice> : null}
      {open && latest.isPending ? <p className="field-note">Abrindo…</p> : null}
      {open ? (
        <ol className="changes">
          {changes.map((change) => {
            const line = describeChange(change, context);
            return (
              <li key={change.id}>
                <span>
                  {line.sentence}
                  {line.before !== undefined ? (
                    <details>
                      <summary>Ver o texto anterior</summary>
                      <p className="item-description">{line.before}</p>
                    </details>
                  ) : null}
                </span>
                <span className="muted">{formatWhen(change.at)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {more.error ? <Notice tone="error">{more.error}</Notice> : null}
      {open && mayHaveMore ? (
        <Button variant="quiet" busy={more.busy} onClick={more.run}>
          Ver mudanças mais antigas
        </Button>
      ) : null}
    </div>
  );
}
