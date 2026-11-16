import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { api, type Item } from '../api.js';
import { formatDuration, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';

/** One item opened in place: what it says, and every stage it has been through. */
export function ItemPanel({
  item,
  canEdit,
  nameOf,
}: {
  item: Item;
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const history = useQuery({
    // Re-read whenever the item changes stage.
    queryKey: ['stage-history', item.id, item.stageSince],
    queryFn: () => api.stageHistory(item.id),
  });
  const changed = title.trim() !== item.title || description !== item.description;
  const save = useAction(
    useCallback(async () => {
      await api.updateItem(item.id, { title: title.trim(), description });
      await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
    }, [item.id, item.listId, title, description, queryClient]),
  );

  return (
    <div className="item-panel">
      {canEdit ? (
        <Form onSubmit={save.run}>
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
          {save.error ? <Notice tone="error">{save.error}</Notice> : null}
          <Button type="submit" busy={save.busy} disabled={!changed || title.trim() === ''}>
            Salvar item
          </Button>
        </Form>
      ) : (
        <p className="item-description">{item.description || 'Sem descrição.'}</p>
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
