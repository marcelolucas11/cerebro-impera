import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError, type CustomField, type Item, type Me, type Stage } from '../api.js';
import { hasValue } from '../fieldvalues.js';
import {
  fromSearch,
  isFiltering,
  matches,
  sortItems,
  toSearch,
  groupItems,
  type Columns,
  type Filter,
  type GroupBy,
  type Sort,
} from '../filters.js';
import { formatDuration } from '../labels.js';
import { describeError } from '../messages.js';
import { Link, listPath, navigate, type ListView } from '../router.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, useAction } from '../ui/kit.js';
import { FIELD_COLUMNS, FieldEditor } from './FieldEditor.js';
import { AddItem } from './AddItem.js';
import { Board } from './Board.js';
import { Calendar } from './Calendar.js';
import { Table } from './Table.js';
import { Timeline } from './Timeline.js';
import { FieldValueView } from './FieldInput.js';
import { ItemPanel } from './ItemPanel.js';
import { BulkBar } from './BulkBar.js';
import { ListTools } from './ListTools.js';
import { SavedViews } from './SavedViews.js';
import { StageEditor } from './StageEditor.js';

const needsCode = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'step_up_required';

/** A list, read the way the team works it: grouped by the stage each item is in. */
export function ListScreen({
  listId,
  view,
  me,
  canSeePeople,
}: {
  listId: string;
  view: ListView;
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
  // Whoever hands out work here sees who can take it, without managing users.
  const handsOutWork =
    list !== undefined &&
    list.itemScope === 'all' &&
    (list.level === 'edit' || list.level === 'manage');
  const workers = useQuery({
    queryKey: ['list-people', listId],
    queryFn: () => api.listPeople(listId),
    enabled: handsOutWork,
  });
  const [editing, setEditing] = useState<'stages' | 'fields' | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const myself = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  // What is narrowed and how it is ordered lives in the address, so it survives a reload.
  const [shaping, setShaping] = useState(() => fromSearch(window.location.search));
  const reshape = useCallback(
    (filter: Filter, sort: Sort, extra: { columns?: Columns; group?: GroupBy } = {}) => {
      setShaping((current) => {
        const next = {
          filter,
          sort,
          columns: extra.columns === undefined ? current.columns : extra.columns,
          group: extra.group ?? current.group,
        };
        window.history.replaceState(
          null,
          '',
          window.location.pathname + toSearch(next.filter, next.sort, next.columns, next.group),
        );
        return next;
      });
    },
    [],
  );
  const search = toSearch(shaping.filter, shaping.sort, shaping.columns, shaping.group);
  // Back and forward bring their own filter with them.
  useEffect(() => {
    const follow = (): void => {
      setShaping(fromSearch(window.location.search));
    };
    window.addEventListener('popstate', follow);
    return () => {
      window.removeEventListener('popstate', follow);
    };
  }, []);

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
  const names = new Map(
    [...(workers.data ?? []), ...(people.data ?? [])].map((user) => [user.id, user.name]),
  );
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
      <nav className="view-switch" aria-label="Ver como">
        <Link to={listPath(listId, 'list', search)} current={view === 'list'}>
          Lista
        </Link>
        <Link to={listPath(listId, 'board', search)} current={view === 'board'}>
          Quadro
        </Link>
        <Link to={listPath(listId, 'calendar', search)} current={view === 'calendar'}>
          Calendário
        </Link>
        <Link to={listPath(listId, 'table', search)} current={view === 'table'}>
          Tabela
        </Link>
        <Link to={listPath(listId, 'timeline', search)} current={view === 'timeline'}>
          Linha do tempo
        </Link>
      </nav>
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
  const { filter, sort } = shaping;
  const visible = sortItems(
    items.data.filter((item) => matches(item, filter, { me: me.id, fields: fields.data })),
    sort,
    fields.data,
  );
  // Only what is on screen counts as chosen: a filter can hide something chosen before.
  const picked = visible.filter((item) => chosen.has(item.id)).map((item) => item.id);
  const selection = canEdit
    ? {
        chosen,
        toggle: (id: string, on: boolean) => {
          setChosen((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          });
        },
      }
    : null;
  const canBulkDelete =
    myself.data !== undefined &&
    (myself.data.user.role === 'owner' || myself.data.capabilities.includes('bulk_delete'));
  const shownStages = stages.data.filter(
    (stage) => filter.stageId === null || stage.id === filter.stageId,
  );
  // Who can be picked in "Responsável": people on these items or who can take them, by name.
  const pickable = [
    ...new Set([
      ...items.data.flatMap((item) => item.assignees),
      ...(workers.data ?? []).map((worker) => worker.id),
    ]),
  ]
    .filter((id) => id !== me.id && names.has(id))
    .map((id) => ({ id, name: names.get(id) ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
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
      {editing === 'stages' ? (
        <StageEditor
          listId={listId}
          listName={list.name}
          stages={stages.data}
          otherLists={otherLists}
        />
      ) : null}
      {editing === 'fields' ? (
        <FieldEditor listId={listId} fields={fields.data} otherLists={otherLists} />
      ) : null}
      <SavedViews
        listId={listId}
        view={view}
        search={search}
        onApply={(saved) => {
          const parsed = fromSearch(saved.query);
          navigate(listPath(listId, saved.kind, saved.query));
          reshape(parsed.filter, parsed.sort, { columns: parsed.columns, group: parsed.group });
        }}
      />
      <ListTools
        filter={filter}
        sort={sort}
        onChange={reshape}
        group={view === 'list' ? shaping.group : null}
        onGroup={(group) => {
          reshape(filter, sort, { group });
        }}
        stages={stages.data}
        fields={fields.data}
        people={pickable}
        shown={visible.length}
        total={items.data.length}
      />
      {view === 'list' && picked.length > 0 ? (
        <BulkBar
          listId={listId}
          ids={picked}
          stages={stages.data}
          workers={handsOutWork ? (workers.data ?? []) : null}
          canBulkDelete={canBulkDelete}
          onDone={() => {
            setChosen(new Set());
          }}
        />
      ) : null}
      {isFiltering(filter) && visible.length === 0 ? (
        <Notice tone="info">Nenhum item corresponde a estes filtros.</Notice>
      ) : null}
      {view === 'board' ? (
        <Board
          listId={listId}
          stages={shownStages}
          items={visible}
          manualOrder={sort.key === 'manual' && !sort.descending}
          fields={fields.data}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
          workers={handsOutWork ? (workers.data ?? []) : null}
        />
      ) : null}
      {view === 'table' ? (
        <Table
          stages={stages.data}
          items={visible}
          fields={fields.data}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
          workers={handsOutWork ? (workers.data ?? []) : null}
          sort={sort}
          columns={shaping.columns}
          onSort={(next) => {
            reshape(filter, next);
          }}
          onColumns={(next) => {
            reshape(filter, sort, { columns: next });
          }}
        />
      ) : null}
      {view === 'timeline' ? (
        <Timeline
          stages={stages.data}
          items={visible}
          fields={fields.data}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
          workers={handsOutWork ? (workers.data ?? []) : null}
        />
      ) : null}
      {view === 'calendar' ? (
        <Calendar
          items={visible}
          fields={fields.data}
          canEdit={canEdit}
          nameOf={nameOf}
          listNameOf={listNameOf}
          workers={handsOutWork ? (workers.data ?? []) : null}
        />
      ) : null}
      {view === 'list' && shaping.group !== 'stage'
        ? groupItems(visible, shaping.group, { fields: fields.data, nameOf }).map((group) => (
            <ItemGroup
              key={group.key}
              name={group.label}
              color={group.color}
              stage={null}
              selection={selection}
              stages={stages.data}
              fields={fields.data}
              columns={columns}
              items={group.items}
              canEdit={canEdit}
              nameOf={nameOf}
              listNameOf={listNameOf}
              workers={handsOutWork ? (workers.data ?? []) : null}
            />
          ))
        : null}
      {view === 'list' && shaping.group === 'stage'
        ? shownStages.map((stage) => (
            <ItemGroup
              key={stage.id}
              name={stage.name}
              color={stage.color}
              stage={stage}
              selection={selection}
              stages={stages.data}
              fields={fields.data}
              columns={columns}
              items={visible.filter((item) => item.stageId === stage.id)}
              canEdit={canEdit}
              nameOf={nameOf}
              listNameOf={listNameOf}
              workers={handsOutWork ? (workers.data ?? []) : null}
            />
          ))
        : null}
      <Trash listId={listId} canEdit={canEdit} nameOf={nameOf} />
    </>
  );
}

/** A group of rows: a stage (where new items can be added), a person or a field's value. */
function ItemGroup({
  name,
  color,
  stage,
  selection,
  stages,
  fields,
  columns,
  items,
  canEdit,
  nameOf,
  listNameOf,
  workers,
}: {
  name: string;
  color: string | null;
  /** The stage this group is, when grouped by stage: new items go there. */
  stage: Stage | null;
  /** Items chosen for a change to several at once; null when the person cannot change them. */
  selection: { chosen: Set<string>; toggle: (id: string, chosen: boolean) => void } | null;
  stages: Stage[];
  fields: CustomField[];
  /** The fields shown as columns of the list. */
  columns: CustomField[];
  items: Item[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
  /** People work here can be handed to; null for someone who does not hand out work. */
  workers: { id: string; name: string }[] | null;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <section
      className="stage-group"
      aria-label={stage !== null ? `Etapa ${name}` : `Grupo ${name}`}
    >
      <h2>
        <button
          type="button"
          className="stage-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {color !== null ? (
            <span className="stage-mark" style={{ background: color }} aria-hidden="true" />
          ) : null}
          {name}
          <span className="stage-count">
            {items.length === 1 ? '1 item' : `${items.length} itens`}
          </span>
        </button>
      </h2>
      {open ? (
        <>
          {items.length === 0 ? (
            <p className="field-note">
              {stage !== null ? 'Nenhum item nesta etapa.' : 'Nenhum item neste grupo.'}
            </p>
          ) : null}
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
                pick={
                  selection === null
                    ? null
                    : {
                        chosen: selection.chosen.has(item.id),
                        toggle: (chosen) => {
                          selection.toggle(item.id, chosen);
                        },
                      }
                }
                stages={stages}
                fields={fields}
                columns={columns}
                canEdit={canEdit}
                nameOf={nameOf}
                listNameOf={listNameOf}
                workers={workers}
              />
            ))}
          </ul>
          {canEdit && stage !== null ? <AddItem stage={stage} /> : null}
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
  pick,
  stages,
  fields,
  columns,
  canEdit,
  nameOf,
  listNameOf,
  workers,
}: {
  item: Item;
  /** Whether this row is chosen for a change to several items; null when nothing can be chosen. */
  pick: { chosen: boolean; toggle: (chosen: boolean) => void } | null;
  stages: Stage[];
  fields: CustomField[];
  columns: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
  /** People work here can be handed to; null for someone who does not hand out work. */
  workers: { id: string; name: string }[] | null;
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
        <span className="item-lead">
          {pick !== null ? (
            <input
              type="checkbox"
              className="item-pick"
              aria-label={`Selecionar ${item.title}`}
              checked={pick.chosen}
              onChange={(event) => {
                pick.toggle(event.target.checked);
              }}
            />
          ) : null}
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
        </span>
        <span className="muted">
          {assignees.length === 0 ? 'Sem responsável' : `Com ${assignees.join(', ')}`}
        </span>
        <span className="muted">
          há {formatDuration(Date.now() - Date.parse(item.stageSince))}
          <span className="visually-hidden"> nesta etapa</span>
        </span>
        {columns.map((field) =>
          field.kind === 'secret' ? (
            // A secret is never in a list: only whether there is one.
            <span
              key={field.id}
              className={item.secrets.includes(field.id) ? 'item-cell' : 'item-cell is-empty'}
            >
              <span className="cell-name">{field.name}: </span>
              {item.secrets.includes(field.id) ? (
                <>
                  <span aria-hidden="true">••••••</span>
                  <span className="visually-hidden">guardado</span>
                </>
              ) : null}
            </span>
          ) : (
            <span
              key={field.id}
              className={
                hasValue(field, item.fields[field.id]) ? 'item-cell' : 'item-cell is-empty'
              }
            >
              <span className="cell-name">{field.name}: </span>
              <FieldValueView field={field} value={item.fields[field.id]} nameOf={nameOf} />
            </span>
          ),
        )}
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
          workers={workers}
        />
      ) : null}
    </li>
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
