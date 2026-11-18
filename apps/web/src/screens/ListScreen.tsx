import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError, type CustomField, type Item, type Me, type Stage } from '../api.js';
import { hasValue } from '../fieldvalues.js';
import { formatDuration } from '../labels.js';
import { describeError } from '../messages.js';
import { Link } from '../router.js';
import { useGuard } from '../stepup.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';
import { FIELD_COLUMNS, FieldEditor } from './FieldEditor.js';
import { FieldValueView } from './FieldInput.js';
import { ItemPanel } from './ItemPanel.js';
import { StageEditor } from './StageEditor.js';

const needsCode = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'step_up_required';

/** A list, read the way the team works it: grouped by the stage each item is in. */
export function ListScreen({
  listId,
  me,
  canSeePeople,
}: {
  listId: string;
  me: Me['user'];
  canSeePeople: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  const list = tree.data?.lists.find((candidate) => candidate.id === listId);
  const stages = useQuery({
    queryKey: ['stages', listId],
    queryFn: () => api.stages(listId),
    enabled: list !== undefined,
  });
  const items = useQuery({
    queryKey: ['items', listId],
    queryFn: () => api.items(listId),
    enabled: list !== undefined,
    refetchInterval: 20_000,
  });
  const fields = useQuery({
    queryKey: ['fields', listId],
    queryFn: () => api.fields(listId),
    enabled: list !== undefined,
  });
  const people = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: canSeePeople });
  const [editing, setEditing] = useState<'stages' | 'fields' | null>(null);

  const unlock = useAction(
    useCallback(async () => {
      await guard(() => api.stages(listId));
      await queryClient.invalidateQueries({ queryKey: ['stages', listId] });
      await queryClient.invalidateQueries({ queryKey: ['fields', listId] });
      await queryClient.invalidateQueries({ queryKey: ['items', listId] });
    }, [guard, listId, queryClient]),
  );

  if (tree.isPending) return <p className="lead">Abrindo…</p>;
  if (tree.isError) return <Notice tone="error">{describeError(tree.error)}</Notice>;
  if (!list) {
    return (
      <>
        <h1>Lista não encontrada</h1>
        <p className="lead">Ela não existe, ou não foi liberada para você.</p>
        <Link to="/" current={false}>
          Ir para Espaços
        </Link>
      </>
    );
  }

  const space = tree.data.spaces.find((candidate) => candidate.id === list.spaceId);
  const folder = tree.data.folders.find((candidate) => candidate.id === list.folderId);
  const names = new Map((people.data ?? []).map((user) => [user.id, user.name]));
  const nameOf = (userId: string | null): string =>
    userId === null ? 'sistema' : userId === me.id ? 'você' : (names.get(userId) ?? 'outra pessoa');
  const canEdit = list.level === 'edit' || list.level === 'manage';
  // Only lists this person can open are named; any other is "outra lista" in the history.
  const listNameOf = (id: string): string | undefined =>
    tree.data.lists.find((candidate) => candidate.id === id)?.name;

  const heading = (
    <header className="list-head">
      <p className="muted">
        {[space?.name, folder?.name].filter((part) => part !== undefined).join(' › ')}
      </p>
      <h1>
        {list.name}
        {list.isSensitive ? <span className="tag tag-brand">sensível</span> : null}
      </h1>
      {list.itemScope === 'assigned' ? (
        <p className="muted">Você vê aqui só os itens que são seus.</p>
      ) : null}
    </header>
  );

  if (needsCode(stages.error) || needsCode(items.error) || needsCode(fields.error)) {
    return (
      <>
        {heading}
        <p className="lead">
          Esta lista é sensível: para abri-la, confirme o código do seu autenticador. Cada abertura
          fica registrada.
        </p>
        {unlock.error ? <Notice tone="error">{unlock.error}</Notice> : null}
        <Button busy={unlock.busy} onClick={unlock.run}>
          Confirmar código e abrir
        </Button>
      </>
    );
  }
  if (stages.isError) return <Notice tone="error">{describeError(stages.error)}</Notice>;
  if (items.isError) return <Notice tone="error">{describeError(items.error)}</Notice>;
  if (fields.isError) return <Notice tone="error">{describeError(fields.error)}</Notice>;
  if (stages.isPending || items.isPending || fields.isPending) {
    return (
      <>
        {heading}
        <p className="lead">Abrindo…</p>
      </>
    );
  }

  const columns = fields.data.slice(0, FIELD_COLUMNS);
  // Lists whose fields could be copied into this one: every other list the person can open.
  const otherLists = tree.data.lists
    .filter((other) => other.id !== listId)
    .map((other) => ({
      id: other.id,
      label: [
        tree.data.spaces.find((candidate) => candidate.id === other.spaceId)?.name,
        other.name,
      ]
        .filter((part) => part !== undefined)
        .join(' › '),
    }));

  return (
    <>
      {heading}
      {list.level === 'manage' ? (
        <div className="actions">
          <Button
            variant="quiet"
            onClick={() => {
              setEditing(editing === 'stages' ? null : 'stages');
            }}
          >
            {editing === 'stages' ? 'Fechar edição das etapas' : 'Editar etapas'}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setEditing(editing === 'fields' ? null : 'fields');
            }}
          >
            {editing === 'fields' ? 'Fechar edição dos campos' : 'Editar campos'}
          </Button>
        </div>
      ) : null}
      {editing === 'stages' ? <StageEditor listId={listId} stages={stages.data} /> : null}
      {editing === 'fields' ? (
        <FieldEditor listId={listId} fields={fields.data} otherLists={otherLists} />
      ) : null}
      {stages.data.map((stage) => (
        <StageGroup
          key={stage.id}
          stage={stage}
          stages={stages.data}
          fields={fields.data}
          columns={columns}
          items={items.data.filter((item) => item.stageId === stage.id)}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
        />
      ))}
      <Trash listId={listId} canEdit={canEdit} nameOf={nameOf} />
    </>
  );
}

function StageGroup({
  stage,
  stages,
  fields,
  columns,
  items,
  canEdit,
  nameOf,
  listNameOf,
}: {
  stage: Stage;
  stages: Stage[];
  fields: CustomField[];
  /** The fields shown as columns of the list. */
  columns: CustomField[];
  items: Item[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <section className="stage-group" aria-label={`Etapa ${stage.name}`}>
      <h2>
        <button
          type="button"
          className="stage-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="stage-mark" style={{ background: stage.color }} aria-hidden="true" />
          {stage.name}
          <span className="stage-count">
            {items.length === 1 ? '1 item' : `${items.length} itens`}
          </span>
        </button>
      </h2>
      {open ? (
        <>
          {items.length === 0 ? <p className="field-note">Nenhum item nesta etapa.</p> : null}
          {items.length > 0 && columns.length > 0 ? (
            // Read by sight only: each cell below repeats its own field name for screen readers.
            <div
              className="item-row has-columns item-head"
              style={columnsOf(columns)}
              aria-hidden="true"
            >
              <span>Item</span>
              <span>Responsável</span>
              <span>Nesta etapa</span>
              {columns.map((field) => (
                <span key={field.id}>{field.name}</span>
              ))}
              <span>Etapa</span>
            </div>
          ) : null}
          <ul className="item-rows">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                stages={stages}
                fields={fields}
                columns={columns}
                canEdit={canEdit}
                nameOf={nameOf}
                listNameOf={listNameOf}
              />
            ))}
          </ul>
          {canEdit ? <AddItem stage={stage} /> : null}
        </>
      ) : null}
    </section>
  );
}

/** How many field columns a row has, handed to the stylesheet. */
const columnsOf = (columns: CustomField[]): CSSProperties =>
  ({ '--colunas': String(columns.length) }) as CSSProperties;

function ItemRow({
  item,
  stages,
  fields,
  columns,
  canEdit,
  nameOf,
  listNameOf,
}: {
  item: Item;
  stages: Stage[];
  fields: CustomField[];
  columns: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
}): ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const move = useAction(
    useCallback(
      async (stageId: string) => {
        await api.updateItem(item.id, { stageId });
        await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      },
      [item.id, item.listId, queryClient],
    ),
  );
  const assignees = item.assignees.map((userId) => nameOf(userId));
  return (
    <li>
      <div
        className={columns.length > 0 ? 'item-row has-columns' : 'item-row'}
        style={columnsOf(columns)}
      >
        <button
          type="button"
          className="item-title"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {item.title}
        </button>
        <span className="muted">
          {assignees.length === 0 ? 'Sem responsável' : `Com ${assignees.join(', ')}`}
        </span>
        <span className="muted">
          há {formatDuration(Date.now() - Date.parse(item.stageSince))}
          <span className="visually-hidden"> nesta etapa</span>
        </span>
        {columns.map((field) => (
          <span
            key={field.id}
            className={hasValue(field, item.fields[field.id]) ? 'item-cell' : 'item-cell is-empty'}
          >
            <span className="cell-name">{field.name}: </span>
            <FieldValueView field={field} value={item.fields[field.id]} />
          </span>
        ))}
        {canEdit ? (
          <select
            className="stage-select"
            aria-label={`Etapa de ${item.title}`}
            value={item.stageId}
            disabled={move.busy}
            onChange={(event) => {
              move.run(event.target.value);
            }}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
      {open ? (
        <ItemPanel
          item={item}
          fields={fields}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
        />
      ) : null}
    </li>
  );
}

function AddItem({ stage }: { stage: Stage }): ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const add = useAction(
    useCallback(async () => {
      await api.createItem(stage.listId, { title: title.trim(), stageId: stage.id });
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: ['items', stage.listId] });
    }, [stage.listId, stage.id, title, queryClient]),
  );
  // Closed by default, so a long list stays a list and not a stack of forms.
  if (!open) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        Adicionar item<span className="visually-hidden"> em {stage.name}</span>
      </Button>
    );
  }
  return (
    <Form onSubmit={add.run}>
      <div className="add-item">
        <Field
          label={`Novo item em ${stage.name}`}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          maxLength={500}
          autoFocus
        />
        <Button type="submit" busy={add.busy} disabled={title.trim() === ''}>
          Adicionar
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(false);
          }}
        >
          Fechar
        </Button>
      </div>
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
    </Form>
  );
}

const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

/** What was thrown away from this list, as far as this person can see, and the way back. */
function Trash({
  listId,
  canEdit,
  nameOf,
}: {
  listId: string;
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const trash = useQuery({
    queryKey: ['trash', listId],
    queryFn: () => api.trash(listId),
    enabled: open,
  });
  return (
    <section className="trash" aria-label="Lixeira desta lista">
      <h2>
        <button
          type="button"
          className="stage-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          Lixeira
          {trash.data !== undefined ? (
            <span className="stage-count">
              {trash.data.length === 1 ? '1 item' : `${trash.data.length} itens`}
            </span>
          ) : null}
        </button>
      </h2>
      {open ? (
        <>
          <p className="field-note">
            Itens ficam aqui por {TRASH_DAYS} dias e depois são removidos de vez, com tudo o que
            tinham.
          </p>
          {trash.isError ? <Notice tone="error">{describeError(trash.error)}</Notice> : null}
          {trash.data?.length === 0 ? <p className="field-note">A lixeira está vazia.</p> : null}
          <ul className="rows">
            {(trash.data ?? []).map((item) => (
              <TrashedItem key={item.id} item={item} canEdit={canEdit} nameOf={nameOf} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function TrashedItem({
  item,
  canEdit,
  nameOf,
}: {
  item: Item;
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const restore = useAction(
    useCallback(async () => {
      await api.restoreItem(item.id);
      await queryClient.invalidateQueries({ queryKey: ['trash', item.listId] });
      await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
    }, [item.id, item.listId, queryClient]),
  );
  const sentAt = Date.parse(item.trashedAt ?? '');
  return (
    <li>
      <span>
        {item.title}
        <span className="row-detail">
          Mandado por {nameOf(item.trashedBy)} em {shortDate.format(sentAt)}; sai de vez em{' '}
          {shortDate.format(sentAt + TRASH_DAYS * DAY)}
        </span>
      </span>
      {canEdit ? (
        <Button variant="quiet" busy={restore.busy} onClick={restore.run}>
          Restaurar<span className="visually-hidden"> {item.title}</span>
        </Button>
      ) : null}
      {restore.error ? <Notice tone="error">{restore.error}</Notice> : null}
    </li>
  );
}
