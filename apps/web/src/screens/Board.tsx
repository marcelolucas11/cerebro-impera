import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { api, type CustomField, type Item, type Stage } from '../api.js';
import {
  columnsOf,
  dropTarget,
  edgeScroll,
  indexAt,
  moved,
  placeAt,
  placed,
  stageUnder,
} from '../board.js';
import { Cancelled } from '../cancelled.js';
import { hasValue } from '../fieldvalues.js';
import { formatDuration } from '../labels.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Notice } from '../ui/kit.js';
import { AddItem } from './AddItem.js';
import { ItemMarks } from './ItemMarks.js';
import { FieldValueView } from './FieldInput.js';
import { ItemPanel } from './ItemPanel.js';

/** How many field values a card shows under its title. */
const CARD_FIELDS = 3;

interface Drag {
  item: Item;
  /** Where the pointer is, and where on the card it took hold. */
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  over: string | null;
  /** Where among the cards of that column it would go; null when the order is not manual. */
  index: number | null;
}

export interface PanelProps {
  /** Every item of the list the person received: subtasks and parents are found here. */
  everyone: Item[];
  fields: CustomField[];
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  listNameOf: (listId: string) => string | undefined;
  workers: { id: string; name: string }[] | null;
}

/*
 * The list as a board: one column per stage, a card per item. Cards are
 * dragged by their handle with a mouse, a finger or a pen; every card also
 * has a stage menu, which is how the keyboard and screen readers move it.
 */
export function Board({
  listId,
  stages,
  items,
  manualOrder,
  ...panel
}: PanelProps & {
  listId: string;
  stages: Stage[];
  items: Item[];
  /** The board shows its own order, so cards can be placed by hand. */
  manualOrder: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const board = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const columns = columnsOf(stages, items);
  const opened = items.find((item) => item.id === openId);

  const update = (next: Drag | null): void => {
    dragRef.current = next;
    setDrag(next);
  };

  /** Shown at once, confirmed by the server, undone if it refuses. */
  const move = useCallback(
    async (item: Item, stageId: string): Promise<void> => {
      const key = ['items', listId];
      const before = queryClient.getQueryData<Item[]>(key);
      queryClient.setQueryData<Item[]>(key, (current) =>
        current?.map((one) => (one.id === item.id ? moved(one, stageId, Date.now()) : one)),
      );
      setError(null);
      try {
        await guard(() => api.updateItem(item.id, { stageId }));
        const name = stages.find((stage) => stage.id === stageId)?.name ?? '';
        setSaid(`${item.title} foi para ${name}.`);
      } catch (failure) {
        queryClient.setQueryData(key, before);
        if (!(failure instanceof Cancelled)) setError(describeError(failure));
      } finally {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [guard, listId, queryClient, stages],
  );

  /** Moves to a stage (if another) and places the column in the given order, all shown at once. */
  const place = useCallback(
    async (item: Item, stageId: string, ids: string[]): Promise<void> => {
      const key = ['items', listId];
      const before = queryClient.getQueryData<Item[]>(key);
      queryClient.setQueryData<Item[]>(key, (current) =>
        current === undefined
          ? current
          : placed(
              current.map((one) =>
                one.id === item.id && one.stageId !== stageId
                  ? moved(one, stageId, Date.now())
                  : one,
              ),
              ids,
            ),
      );
      setError(null);
      try {
        if (item.stageId !== stageId) {
          await guard(() => api.updateItem(item.id, { stageId }));
        }
        await guard(() => api.orderStage(listId, stageId, ids));
        const name = stages.find((stage) => stage.id === stageId)?.name ?? '';
        setSaid(`${item.title} ficou na posição ${ids.indexOf(item.id) + 1} de ${name}.`);
      } catch (failure) {
        queryClient.setQueryData(key, before);
        if (!(failure instanceof Cancelled)) setError(describeError(failure));
      } finally {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [guard, listId, queryClient, stages],
  );
  const idsIn = (stageId: string): string[] =>
    columns.find((column) => column.stage.id === stageId)?.items.map((one) => one.id) ?? [];

  const take = (item: Item, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const card = event.currentTarget.closest('.card')?.getBoundingClientRect();
    update({
      item,
      x: event.clientX,
      y: event.clientY,
      offsetX: card ? event.clientX - card.left : 0,
      offsetY: card ? event.clientY - card.top : 0,
      width: card?.width ?? 240,
      over: item.stageId,
      index: null,
    });
  };
  const follow = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = dragRef.current;
    if (!current) return;
    const area = board.current?.getBoundingClientRect();
    if (board.current && area) {
      board.current.scrollLeft += edgeScroll(event.clientX, area.left, area.right);
    }
    const over = stageUnder(document.elementsFromPoint(event.clientX, event.clientY));
    let index: number | null = null;
    if (manualOrder && over !== null) {
      const middles = [
        ...(board.current?.querySelectorAll(`[data-stage-id="${over}"] [data-item-id]`) ?? []),
      ]
        .filter((card) => card.getAttribute('data-item-id') !== current.item.id)
        .map((card) => {
          const box = card.getBoundingClientRect();
          return box.top + box.height / 2;
        });
      index = indexAt(event.clientY, middles);
    }
    update({ ...current, x: event.clientX, y: event.clientY, over, index });
  };
  const drop = (): void => {
    const current = dragRef.current;
    update(null);
    if (!current) return;
    if (manualOrder && current.over !== null && current.index !== null) {
      if (!stages.some((stage) => stage.id === current.over)) return;
      const before = idsIn(current.over);
      const ids = placeAt(before, current.item.id, current.index);
      if (current.over === current.item.stageId && ids.join() === before.join()) return;
      void place(current.item, current.over, ids);
      return;
    }
    const target = dropTarget(current.item.stageId, current.over, stages);
    if (target !== null) void move(current.item, target);
  };

  return (
    <>
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="board" ref={board}>
        {columns.map(({ stage, items: cards }) => (
          <section
            key={stage.id}
            className={
              drag !== null &&
              drag.over === stage.id &&
              (drag.item.stageId !== stage.id || drag.index !== null)
                ? 'board-column is-target'
                : 'board-column'
            }
            data-stage-id={stage.id}
            aria-label={`Etapa ${stage.name}`}
          >
            <h2 className="board-column-head">
              <span className="stage-mark" style={{ background: stage.color }} aria-hidden="true" />
              {stage.name}
              <span className="stage-count">
                {cards.length === 1 ? '1 item' : `${cards.length} itens`}
              </span>
            </h2>
            <ul className="cards">
              {cards.map((item, position) => (
                <Card
                  key={item.id}
                  item={item}
                  stages={stages}
                  dropBefore={
                    drag !== null &&
                    drag.over === stage.id &&
                    drag.index !== null &&
                    cards.filter((one) => one.id !== drag.item.id)[drag.index]?.id === item.id
                  }
                  shift={
                    manualOrder && panel.canEdit
                      ? {
                          up: position > 0,
                          down: position < cards.length - 1,
                          by: (delta: number) => {
                            void place(
                              item,
                              stage.id,
                              placeAt(idsIn(stage.id), item.id, position + delta),
                            );
                          },
                        }
                      : null
                  }
                  lifted={drag?.item.id === item.id}
                  onOpen={() => {
                    setOpenId(item.id);
                  }}
                  onMove={(stageId) => {
                    void move(item, stageId);
                  }}
                  handle={{
                    onPointerDown: (event) => {
                      take(item, event);
                    },
                    onPointerMove: follow,
                    onPointerUp: drop,
                    onPointerCancel: () => {
                      update(null);
                    },
                  }}
                  {...panel}
                />
              ))}
              {drag !== null &&
              drag.over === stage.id &&
              drag.index !== null &&
              drag.index >= cards.filter((one) => one.id !== drag.item.id).length ? (
                <li className="card-drop-line" aria-hidden="true" />
              ) : null}
            </ul>
            {panel.canEdit ? <AddItem stage={stage} /> : null}
          </section>
        ))}
      </div>
      {drag !== null ? (
        <div
          className="card card-ghost"
          aria-hidden="true"
          style={{
            width: drag.width,
            transform: `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px)`,
          }}
        >
          {drag.item.title}
        </div>
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

interface Handle {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

function Card({
  item,
  stages,
  dropBefore,
  shift,
  lifted,
  onOpen,
  onMove,
  handle,
  everyone,
  fields,
  canEdit,
  nameOf,
}: PanelProps & {
  item: Item;
  stages: Stage[];
  /** A card being dragged would land just above this one. */
  dropBefore: boolean;
  /** Moving up or down by one, for the keyboard; null when the order is not manual. */
  shift: { up: boolean; down: boolean; by: (delta: number) => void } | null;
  lifted: boolean;
  onOpen: () => void;
  onMove: (stageId: string) => void;
  handle: Handle;
}): ReactNode {
  const shown = fields
    .filter((field) =>
      field.kind === 'secret'
        ? item.secrets.includes(field.id)
        : hasValue(field, item.fields[field.id]),
    )
    .slice(0, CARD_FIELDS);
  const assignees = item.assignees.map((userId) => nameOf(userId));
  return (
    <>
      {dropBefore ? <li className="card-drop-line" aria-hidden="true" /> : null}
      <li className={lifted ? 'card is-lifted' : 'card'} data-item-id={item.id}>
        <div className="card-top">
          {canEdit ? (
            // Pointer only: the stage menu below is the way for the keyboard.
            <span
              className="card-handle"
              aria-hidden="true"
              title="Arraste para outra etapa"
              {...handle}
            >
              ⠿
            </span>
          ) : null}
          <button type="button" className="card-title" onClick={onOpen}>
            {item.title}
          </button>
        </div>
        <ItemMarks item={item} stages={stages} everyone={everyone} />
        {shown.length > 0 ? (
          <dl className="card-fields">
            {shown.map((field) => (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd>
                  {field.kind === 'secret' ? (
                    <>
                      <span aria-hidden="true">••••••</span>
                      <span className="visually-hidden">guardado</span>
                    </>
                  ) : (
                    <FieldValueView field={field} value={item.fields[field.id]} nameOf={nameOf} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="card-meta">
          <span>{assignees.length === 0 ? 'Sem responsável' : assignees.join(', ')}</span>
          <span>há {formatDuration(Date.now() - Date.parse(item.stageSince))}</span>
        </p>
        {canEdit ? (
          <select
            className="stage-select card-stage"
            aria-label={`Etapa de ${item.title}`}
            value={item.stageId}
            onChange={(event) => {
              onMove(event.target.value);
            }}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        ) : null}
        {shift !== null ? (
          <div className="card-shift">
            <Button
              variant="quiet"
              disabled={!shift.up}
              onClick={() => {
                shift.by(-1);
              }}
            >
              Subir<span className="visually-hidden"> {item.title}</span>
            </Button>
            <Button
              variant="quiet"
              disabled={!shift.down}
              onClick={() => {
                shift.by(1);
              }}
            >
              Descer<span className="visually-hidden"> {item.title}</span>
            </Button>
          </div>
        ) : null}
      </li>
    </>
  );
}

/** An item opened from the board, over it, with everything the list shows when a row opens. */
export function ItemDialog({
  item,
  onClose,
  ...panel
}: PanelProps & { item: Item; onClose: () => void }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="item-dialog" aria-label={item.title} onClose={onClose}>
      <div className="item-dialog-head">
        <h2>{item.title}</h2>
        <Button
          variant="quiet"
          onClick={() => {
            dialog.current?.close();
          }}
        >
          Fechar
        </Button>
      </div>
      <ItemPanel item={item} {...panel} />
    </dialog>
  );
}
