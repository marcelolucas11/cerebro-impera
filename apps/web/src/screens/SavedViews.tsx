import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type SavedView } from '../api.js';
import { describeError } from '../messages.js';
import type { ListView } from '../router.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';

const KIND_NAMES: Record<ListView, string> = {
  list: 'lista',
  board: 'quadro',
  calendar: 'calendário',
};

/*
 * A person's own named views of this list: one tap brings back the way of
 * looking (list or board, filter, order). Nobody else sees them.
 */
export function SavedViews({
  listId,
  view,
  search,
  onApply,
}: {
  listId: string;
  view: ListView;
  /** The current query part of the address. */
  search: string;
  onApply: (saved: SavedView) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: ['views', listId], queryFn: () => api.views(listId) });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const current = (saved.data ?? []).find((one) => one.kind === view && one.query === search);

  const save = useAction(
    useCallback(async () => {
      await api.createView(listId, { name: name.trim(), kind: view, query: search });
      setName('');
      setNaming(false);
      await queryClient.invalidateQueries({ queryKey: ['views', listId] });
    }, [listId, name, view, search, queryClient]),
  );
  const remove = useAction(
    useCallback(async () => {
      if (!current) return;
      await api.deleteView(current.id);
      await queryClient.invalidateQueries({ queryKey: ['views', listId] });
    }, [current, listId, queryClient]),
  );

  return (
    <div className="saved-views">
      {(saved.data ?? []).length > 0 ? (
        <nav className="saved-views-row" aria-label="Suas visões salvas">
          {(saved.data ?? []).map((one) => (
            <button
              key={one.id}
              type="button"
              className="saved-view"
              aria-current={one.id === current?.id ? 'true' : undefined}
              onClick={() => {
                onApply(one);
              }}
            >
              {one.name}
              <span className="saved-view-kind">{KIND_NAMES[one.kind]}</span>
            </button>
          ))}
        </nav>
      ) : null}
      {saved.isError ? <Notice tone="error">{describeError(saved.error)}</Notice> : null}
      {naming ? (
        <Form onSubmit={save.run}>
          <div className="add-item">
            <Field
              label="Nome da visão"
              value={name}
              maxLength={60}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <Button type="submit" busy={save.busy} disabled={name.trim() === ''}>
              Salvar visão
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setNaming(false);
              }}
            >
              Cancelar
            </Button>
          </div>
        </Form>
      ) : (
        <div className="actions">
          {current === undefined ? (
            <Button
              variant="quiet"
              onClick={() => {
                setNaming(true);
              }}
            >
              Salvar esta visão
            </Button>
          ) : (
            <Button variant="quiet" busy={remove.busy} onClick={remove.run}>
              Apagar a visão “{current.name}”
            </Button>
          )}
        </div>
      )}
      {save.error ? <Notice tone="error">{save.error}</Notice> : null}
      {remove.error ? <Notice tone="error">{remove.error}</Notice> : null}
    </div>
  );
}
