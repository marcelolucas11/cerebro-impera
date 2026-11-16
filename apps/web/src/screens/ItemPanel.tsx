import type { FieldValue } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { api, type CustomField, type Item } from '../api.js';
import { draftOf, sameValue, valueOf, type FieldDraft } from '../fieldvalues.js';
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
}: {
  item: Item;
  fields: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
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
    </div>
  );
}
