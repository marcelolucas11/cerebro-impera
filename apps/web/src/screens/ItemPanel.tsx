import { hasCapability, type FieldValue } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { api, type CustomField, type Item, type ItemChange } from '../api.js';
import { draftOf, sameValue, valueOf, type FieldDraft } from '../fieldvalues.js';
import { isoDay } from '../calendar.js';
import { formatDay, PRIORITY_NAMES, priorityLabel } from '../due.js';
import { describeChange } from '../history.js';
import { formatDuration, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';
import { Attachments } from './Attachments.js';
import { FieldInput, FieldValueView } from './FieldInput.js';
import { SecretField } from './SecretField.js';

/** One item opened in place: what it says, what its list records about it, and every stage it has been through. */
export function ItemPanel({
  item,
  fields,
  canEdit,
  nameOf,
  listNameOf,
  workers,
  everyone = [],
}: {
  item: Item;
  fields: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
  /** People this item can be handed to; null when the viewer does not hand out work. */
  workers: { id: string; name: string }[] | null;
  /** Every item of the list the person received: its subtasks and its parent are found here. */
  everyone?: readonly Item[];
}): ReactNode {
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const canReveal =
    me.data !== undefined &&
    hasCapability(
      { role: me.data.user.role, capabilities: me.data.capabilities },
      'secret_fields.reveal',
    );
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [priority, setPriority] = useState(item.priority === null ? '' : String(item.priority));
  const [startDate, setStartDate] = useState(item.startDate ?? '');
  const [dueDate, setDueDate] = useState(item.dueDate ?? '');
  const startId = useId();
  const dueId = useId();
  const datesOutOfOrder = startDate !== '' && dueDate !== '' && startDate > dueDate;
  const planChanges = {
    ...(priority !== (item.priority === null ? '' : String(item.priority))
      ? { priority: priority === '' ? null : Number(priority) }
      : {}),
    ...(startDate !== (item.startDate ?? '')
      ? { startDate: startDate === '' ? null : startDate }
      : {}),
    ...(dueDate !== (item.dueDate ?? '') ? { dueDate: dueDate === '' ? null : dueDate } : {}),
  };
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  // Attachments a files field can name: finished and not in the trash.
  const attachments = useQuery({
    queryKey: ['attachments', item.id],
    queryFn: () => api.attachments(item.id),
  });
  const files = (attachments.data ?? [])
    .filter((file) => file.status !== 'uploading')
    .map((file) => ({ id: file.id, name: file.name }));
  const fileNames = (value: FieldValue | undefined): string =>
    (Array.isArray(value) ? value : [])
      .map((fileId) => files.find((file) => file.id === fileId)?.name)
      .filter((name): name is string => name !== undefined)
      .join(', ');
  const history = useQuery({
    // Re-read whenever the item changes stage.
    queryKey: ['stage-history', item.id, item.stageSince],
    queryFn: () => api.stageHistory(item.id),
  });

  // Secrets are kept and revealed one by one, never through the item's form.
  const ordinary = fields.filter((field) => field.kind !== 'secret');
  const secrets = fields.filter((field) => field.kind === 'secret');

  // What each field would be saved as, or what is wrong with what was typed.
  const parsed = ordinary.map((field) => {
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
  const invalid = parsed.some(({ result }) => result !== null && !result.ok) || datesOutOfOrder;
  const changed =
    title.trim() !== item.title ||
    description !== item.description ||
    Object.keys(planChanges).length > 0 ||
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
      ...planChanges,
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
          <div className="item-plan">
            <Select
              label="Prioridade"
              value={priority}
              onChange={setPriority}
              options={[
                { value: '', label: 'Sem prioridade' },
                ...Object.keys(PRIORITY_NAMES).map((key) => ({
                  value: key,
                  label: priorityLabel(Number(key)) ?? key,
                })),
              ]}
            />
            <div className="field">
              <label htmlFor={startId}>Começa em</label>
              <input
                id={startId}
                type="date"
                value={startDate}
                max={dueDate === '' ? undefined : dueDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={dueId}>Prazo</label>
              <input
                id={dueId}
                type="date"
                value={dueDate}
                min={startDate === '' ? undefined : startDate}
                aria-invalid={datesOutOfOrder || undefined}
                aria-describedby={datesOutOfOrder ? `${dueId}-erro` : undefined}
                onChange={(event) => {
                  setDueDate(event.target.value);
                }}
              />
              {datesOutOfOrder ? (
                <p className="field-note field-note-error" id={`${dueId}-erro`}>
                  O prazo não pode vir antes do começo.
                </p>
              ) : null}
            </div>
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
                  workers={workers}
                  nameOf={nameOf}
                  files={files}
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
          {item.priority !== null || item.startDate !== null || item.dueDate !== null ? (
            <dl className="item-facts">
              {item.priority !== null ? (
                <div>
                  <dt>Prioridade</dt>
                  <dd>{priorityLabel(item.priority)}</dd>
                </div>
              ) : null}
              {item.startDate !== null ? (
                <div>
                  <dt>Começa em</dt>
                  <dd>{formatDay(item.startDate, isoDay(new Date()))}</dd>
                </div>
              ) : null}
              {item.dueDate !== null ? (
                <div>
                  <dt>Prazo</dt>
                  <dd>{formatDay(item.dueDate, isoDay(new Date()))}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {ordinary.length > 0 ? (
            <dl className="item-facts">
              {ordinary.map((field) => (
                <div key={field.id}>
                  <dt>{field.name}</dt>
                  <dd>
                    {field.kind === 'files' ? (
                      fileNames(item.fields[field.id])
                    ) : (
                      <FieldValueView field={field} value={item.fields[field.id]} nameOf={nameOf} />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
      {secrets.length > 0 ? (
        <div className="item-secrets">
          {secrets.map((field) => (
            <SecretField
              key={field.id}
              item={item}
              field={field}
              canEdit={canEdit}
              canReveal={canReveal}
            />
          ))}
          <p className="field-note">
            {canReveal
              ? 'Revelar ou copiar pede o código do autenticador e fica no registro de auditoria.'
              : 'Só um Dono, ou quem recebeu dele a capacidade de revelar campos secretos, vê o valor.'}
          </p>
        </div>
      ) : null}
      <Checklist item={item} canEdit={canEdit} />
      <Subtasks item={item} everyone={everyone} canEdit={canEdit} />
      <Attachments item={item} canEdit={canEdit} nameOf={nameOf} />
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
      {workers !== null ? (
        <Assignees key={item.assignees.join()} item={item} workers={workers} nameOf={nameOf} />
      ) : null}
      {canEdit ? <MoveToList item={item} /> : null}
      {canEdit ? (
        <SendToTrash
          item={item}
          subtasks={everyone.filter((other) => other.parentId === item.id).length}
        />
      ) : null}
      <ItemHistory
        // What the item is now is part of the key: a change made here shows up at once.
        key={item.updatedAt}
        item={item}
        fields={fields}
        nameOf={nameOf}
        listNameOf={listNameOf}
        everyone={everyone}
      />
    </div>
  );
}

/** The item's checklist: lines ticked by whoever edits the item, read by whoever sees it. */
function Checklist({ item, canEdit }: { item: Item; canEdit: boolean }): ReactNode {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const lines = useQuery({
    queryKey: ['checklist', item.id],
    queryFn: () => api.checklist(item.id),
  });
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['checklist', item.id] });
    await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
  }, [item.id, item.listId, queryClient]);
  const add = useAction(
    useCallback(async () => {
      await api.addCheck(item.id, text.trim());
      setText('');
      await refresh();
    }, [item.id, text, refresh]),
  );
  // A tick shows at once, and goes back only if the server refuses it.
  const [ticking, setTicking] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [tickError, setTickError] = useState<string | null>(null);
  const tick = (checkId: string, done: boolean): void => {
    setTicking((current) => new Map(current).set(checkId, done));
    setTickError(null);
    void api
      .updateCheck(checkId, { done })
      .then(refresh)
      .catch((failure: unknown) => {
        setTickError(describeError(failure));
      })
      .finally(() => {
        setTicking((current) => {
          const next = new Map(current);
          next.delete(checkId);
          return next;
        });
      });
  };
  const remove = useAction(
    useCallback(
      async (checkId: string) => {
        await api.removeCheck(checkId);
        await refresh();
      },
      [refresh],
    ),
  );
  const found = lines.data ?? [];
  if (found.length === 0 && !canEdit) return null;
  const isDone = (line: { id: string; done: boolean }): boolean =>
    ticking.get(line.id) ?? line.done;
  const done = found.filter(isDone).length;
  return (
    <div className="subsection">
      <h3>
        Checklist
        {found.length > 0 ? (
          <span className="stage-count">
            {done} de {found.length}
          </span>
        ) : null}
      </h3>
      {lines.isError ? <Notice tone="error">{describeError(lines.error)}</Notice> : null}
      {found.length > 0 ? (
        <ul className="checklist">
          {found.map((line) => (
            <li key={line.id} className={isDone(line) ? 'is-done' : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={isDone(line)}
                  disabled={!canEdit || ticking.has(line.id)}
                  onChange={(event) => {
                    tick(line.id, event.target.checked);
                  }}
                />
                <span>{line.text}</span>
              </label>
              {canEdit ? (
                <Button
                  variant="quiet"
                  busy={remove.busy}
                  onClick={() => {
                    remove.run(line.id);
                  }}
                >
                  Tirar<span className="visually-hidden"> da checklist: {line.text}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : canEdit ? (
        <p className="field-note">Nada na checklist ainda.</p>
      ) : null}
      {canEdit && found.length < 100 ? (
        <Form onSubmit={add.run}>
          <div className="add-item">
            <Field
              label={`Nova linha na checklist de ${item.title}`}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              maxLength={500}
            />
            <Button type="submit" busy={add.busy} disabled={text.trim() === ''}>
              Pôr na checklist
            </Button>
          </div>
        </Form>
      ) : null}
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
      {tickError !== null ? <Notice tone="error">{tickError}</Notice> : null}
      {remove.error ? <Notice tone="error">{remove.error}</Notice> : null}
    </div>
  );
}

/**
 * The item's subtasks and a way to add one; or, for a subtask, the item it
 * hangs from and a way to take it out. Only items the person received are
 * named: a parent they cannot see is "another item".
 */
function Subtasks({
  item,
  everyone,
  canEdit,
}: {
  item: Item;
  everyone: readonly Item[];
  canEdit: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['items', item.listId] }),
    [item.listId, queryClient],
  );
  const add = useAction(
    useCallback(async () => {
      await api.createItem(item.listId, { title: title.trim(), parentId: item.id });
      setTitle('');
      await refresh();
    }, [item.listId, item.id, title, refresh]),
  );
  const detach = useAction(
    useCallback(async () => {
      await api.updateItem(item.id, { parentId: null });
      await refresh();
    }, [item.id, refresh]),
  );

  if (item.parentId !== null) {
    const parent = everyone.find((other) => other.id === item.parentId);
    const name = parent ? `“${parent.title}”` : 'outro item';
    return (
      <div className="subsection">
        <h3>Subtarefa</h3>
        <p className="field-note">Este item é uma subtarefa de {name}.</p>
        {canEdit ? (
          <Button variant="quiet" busy={detach.busy} onClick={detach.run}>
            Tirar de dentro de {name}
          </Button>
        ) : null}
        {detach.error ? <Notice tone="error">{detach.error}</Notice> : null}
      </div>
    );
  }

  const children = everyone.filter((other) => other.parentId === item.id);
  if (children.length === 0 && !canEdit) return null;
  return (
    <div className="subsection">
      <h3>Subtarefas</h3>
      {children.length > 0 ? (
        <ul className="subtask-names">
          {children.map((child) => (
            <li key={child.id}>{child.title}</li>
          ))}
        </ul>
      ) : (
        <p className="field-note">Nenhuma subtarefa.</p>
      )}
      {canEdit ? (
        <Form onSubmit={add.run}>
          <div className="add-item">
            <Field
              label={`Nova subtarefa de ${item.title}`}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              maxLength={500}
            />
            <Button type="submit" busy={add.busy} disabled={title.trim() === ''}>
              Adicionar subtarefa
            </Button>
          </div>
        </Form>
      ) : null}
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
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
  everyone,
}: {
  item: Item;
  fields: CustomField[];
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
  everyone: readonly Item[];
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
    itemTitleOf: (itemId: string) => everyone.find((other) => other.id === itemId)?.title,
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

/**
 * Sends the item to the trash of its list, where it can be brought back for
 * 30 days. Its subtasks go along, which makes several items: that asks for
 * the code again and is only for who may remove several at once.
 */
function SendToTrash({ item, subtasks }: { item: Item; subtasks: number }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const send = useAction(
    useCallback(async () => {
      await guard(() => api.trashItem(item.id));
      await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      await queryClient.invalidateQueries({ queryKey: ['trash', item.listId] });
    }, [guard, item.id, item.listId, queryClient]),
  );
  return (
    <div className="subsection">
      <Button variant="quiet" busy={send.busy} onClick={send.run}>
        Mandar para a lixeira<span className="visually-hidden"> {item.title}</span>
      </Button>
      <p className="field-note">
        {subtasks > 0
          ? `Leva junto ${subtasks === 1 ? 'a subtarefa' : `as ${String(subtasks)} subtarefas`}: são vários itens de uma vez, então pede o código do autenticador e a capacidade “Apagar em massa”. Ficam 30 dias na lixeira e voltam juntos.`
          : 'Fica 30 dias na lixeira da lista, de onde pode voltar como está.'}
      </p>
      {send.error ? <Notice tone="error">{send.error}</Notice> : null}
    </div>
  );
}

/** Moves the item to another list this person may edit in, onto that list's first stage. */
function MoveToList({ item }: { item: Item }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  const spaceOf = (spaceId: string): string | undefined =>
    tree.data?.spaces.find((space) => space.id === spaceId)?.name;
  const destinations = (tree.data?.lists ?? [])
    .filter((list) => list.id !== item.listId && (list.level === 'edit' || list.level === 'manage'))
    .map((list) => ({
      value: list.id,
      label: [spaceOf(list.spaceId), list.name].filter((part) => part !== undefined).join(' › '),
    }));
  const [to, setTo] = useState('');
  const move = useAction(
    useCallback(async () => {
      // Into a sensitive list, the authenticator code is asked first.
      await guard(() => api.moveItem(item.id, { listId: to }));
      await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      await queryClient.invalidateQueries({ queryKey: ['items', to] });
    }, [guard, item.id, item.listId, to, queryClient]),
  );
  if (destinations.length === 0) return null;
  return (
    <div className="subsection">
      <h3>Mover para outra lista</h3>
      <div className="move-to">
        <Select
          label={`Lista de destino de ${item.title}`}
          value={to}
          onChange={setTo}
          options={[{ value: '', label: 'Escolha a lista' }, ...destinations]}
        />
        <Button variant="quiet" busy={move.busy} disabled={to === ''} onClick={move.run}>
          Mover item
        </Button>
      </div>
      <p className="field-note">
        O item entra na primeira etapa da outra lista. Campos que as duas listas têm em comum vão
        junto; os demais ficam guardados aqui e voltam se o item voltar.
      </p>
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
    </div>
  );
}

/** Who the item is handed to, chosen among the people who can work in its list. */
function Assignees({
  item,
  workers,
  nameOf,
}: {
  item: Item;
  workers: { id: string; name: string }[];
  nameOf: (userId: string | null) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<string[]>(item.assignees);
  // Someone already on the item who can no longer be offered (access removed) still shows.
  const offered = [
    ...workers,
    ...item.assignees
      .filter((id) => !workers.some((worker) => worker.id === id))
      .map((id) => ({ id, name: nameOf(id) })),
  ];
  const changed =
    chosen.length !== item.assignees.length || chosen.some((id) => !item.assignees.includes(id));
  const save = useAction(
    useCallback(async () => {
      await api.setAssignees(item.id, chosen);
      await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
    }, [item.id, item.listId, chosen, queryClient]),
  );
  return (
    <div className="subsection">
      <fieldset className="ticks">
        <legend>
          <h3>Responsáveis</h3>
        </legend>
        {offered.map((person) => (
          <label key={person.id} className="tick">
            <input
              type="checkbox"
              checked={chosen.includes(person.id)}
              onChange={(event) => {
                setChosen(
                  event.target.checked
                    ? [...chosen, person.id]
                    : chosen.filter((other) => other !== person.id),
                );
              }}
            />
            {person.name}
          </label>
        ))}
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        <div className="actions">
          <Button variant="quiet" busy={save.busy} disabled={!changed} onClick={save.run}>
            Salvar responsáveis
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
