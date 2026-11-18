import { MAX_HOME_PINS } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, ApiError, type Home as HomeData, type HomeItem, type Tree } from '../api.js';
import { isoDay } from '../calendar.js';
import { dueState, dueText, priorityLabel } from '../due.js';
import { DEFAULT_SORT, NO_FILTER, toSearch } from '../filters.js';
import { groupItems, listPlace, movePin, pin, pinChoices, unpin } from '../home.js';
import { describeError } from '../messages.js';
import { Link, listPath } from '../router.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, Select, useAction } from '../ui/kit.js';
import { useUnreadNotifications } from './Notifications.js';
import { Summary } from './Summary.js';

/*
 * Where a person starts: what is with them and when it is due, whether
 * anything waits to be read, and the panels of the lists they follow, in
 * their order. Everything comes with their own access, so a list or item they
 * lose leaves this page by itself.
 */
export function Home({ name }: { name: string }): ReactNode {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ['home'], queryFn: api.home });
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  const unread = useUnreadNotifications();
  const save = useAction(
    useCallback(
      async (pins: string[]) => {
        const next = await api.setHomePins(pins);
        queryClient.setQueryData<HomeData>(['home'], next);
      },
      [queryClient],
    ),
  );

  if (home.isPending || tree.isPending) return <p className="lead">Abrindo…</p>;
  if (home.isError) return <Notice tone="error">{describeError(home.error)}</Notice>;
  if (tree.isError) return <Notice tone="error">{describeError(tree.error)}</Notice>;
  const { items, pins } = home.data;

  return (
    <div className="home">
      <h1>Início</h1>
      <p className="lead">
        {`Olá, ${name.split(' ')[0] ?? name}. `}
        {unread === 0 ? (
          'Nenhum aviso esperando leitura.'
        ) : (
          <Link to="/avisos" current={false}>
            {unread === 1 ? '1 aviso não lido' : `${String(unread)} avisos não lidos`}
          </Link>
        )}
      </p>

      <section className="home-section" aria-labelledby="home-items">
        <h2 id="home-items">Com você</h2>
        <MyItems items={items} />
      </section>

      <section className="home-section" aria-labelledby="home-panels">
        <h2 id="home-panels">Painéis</h2>
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        {pins.length === 0 ? (
          <p className="muted">
            Fixe aqui as listas que você acompanha para ver os números delas ao entrar.
          </p>
        ) : (
          <ol className="home-panels">
            {pins.map((listId, index) => (
              <PinnedPanel
                key={listId}
                tree={tree.data}
                listId={listId}
                first={index === 0}
                last={index === pins.length - 1}
                busy={save.busy}
                onMove={(step) => {
                  save.run(movePin(pins, listId, step));
                }}
                onRemove={() => {
                  save.run(unpin(pins, listId));
                }}
              />
            ))}
          </ol>
        )}
        <PinPicker
          tree={tree.data}
          pins={pins}
          busy={save.busy}
          onPin={(listId) => {
            save.run(pin(pins, listId));
          }}
        />
      </section>
    </div>
  );
}

function MyItems({ items }: { items: HomeItem[] }): ReactNode {
  const today = isoDay(new Date());
  if (items.length === 0) {
    return (
      <p className="muted">Nada em aberto com você. O que alguém passar para você aparece aqui.</p>
    );
  }
  return (
    <>
      {groupItems(items).map((group) => (
        <div key={group.due} className={`home-group home-group-${group.due}`}>
          <h3>
            {group.title}
            <span className="home-count">{group.items.length}</span>
          </h3>
          <ul className="rows">
            {group.items.map((item) => {
              const state = dueState(item.dueDate, today, false);
              const priority = priorityLabel(item.priority);
              return (
                <li key={item.id}>
                  <span>
                    <Link
                      to={listPath(
                        item.listId,
                        'list',
                        toSearch({ ...NO_FILTER, text: item.title }, DEFAULT_SORT),
                      )}
                      current={false}
                    >
                      {item.title}
                    </Link>
                    <span className="row-detail">
                      {item.listName}, em {item.stageName}
                    </span>
                  </span>
                  <span className="home-when">
                    {item.dueDate === null || state === null
                      ? 'Sem prazo'
                      : dueText(item.dueDate, today, state)}
                    {priority === null ? null : <span className="tag">{priority}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {items.length >= 200 ? (
        <p className="muted">Mostrando os 200 primeiros, pelo prazo.</p>
      ) : null}
    </>
  );
}

function PinnedPanel({
  tree,
  listId,
  first,
  last,
  busy,
  onMove,
  onRemove,
}: {
  tree: Tree;
  listId: string;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const list = tree.lists.find((candidate) => candidate.id === listId);
  const stages = useQuery({
    queryKey: ['stages', listId],
    queryFn: () => api.stages(listId),
    enabled: list !== undefined,
  });
  // A sensitive list shows its numbers only after the code is confirmed again.
  const unlock = useAction(
    useCallback(async () => {
      await guard(() => api.stages(listId));
      await queryClient.invalidateQueries({ queryKey: ['stages', listId] });
      await queryClient.invalidateQueries({ queryKey: ['summary', listId] });
    }, [guard, listId, queryClient]),
  );
  if (list === undefined) return null;
  const place = listPlace(tree, listId) ?? list.name;
  const locked = stages.error instanceof ApiError && stages.error.code === 'step_up_required';

  return (
    <li className="home-panel">
      <header className="home-panel-head">
        <h3>
          <Link to={listPath(listId, 'summary')} current={false}>
            {list.name}
          </Link>
          {list.isSensitive ? <span className="tag tag-brand">sensível</span> : null}
          <span className="row-detail">{place}</span>
        </h3>
        <div className="home-panel-tools">
          <Button
            variant="quiet"
            disabled={first || busy}
            aria-label={`Subir ${list.name}`}
            onClick={() => {
              onMove(-1);
            }}
          >
            Subir
          </Button>
          <Button
            variant="quiet"
            disabled={last || busy}
            aria-label={`Descer ${list.name}`}
            onClick={() => {
              onMove(1);
            }}
          >
            Descer
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            aria-label={`Tirar ${list.name} do início`}
            onClick={onRemove}
          >
            Tirar
          </Button>
        </div>
      </header>
      {locked ? (
        <div className="home-locked">
          <p className="muted">Lista sensível: confirme o código para ver os números.</p>
          {unlock.error ? <Notice tone="error">{unlock.error}</Notice> : null}
          <Button variant="quiet" onClick={unlock.run} busy={unlock.busy}>
            Confirmar o código
          </Button>
        </div>
      ) : stages.isError ? (
        <Notice tone="error">{describeError(stages.error)}</Notice>
      ) : stages.isPending ? (
        <p className="muted">Contando…</p>
      ) : (
        <Summary
          listId={listId}
          stages={stages.data}
          fields={[]}
          seesAll={list.itemScope === 'all'}
          compact
        />
      )}
    </li>
  );
}

function PinPicker({
  tree,
  pins,
  busy,
  onPin,
}: {
  tree: Tree;
  pins: string[];
  busy: boolean;
  onPin: (listId: string) => void;
}): ReactNode {
  const choices = pinChoices(tree, pins);
  const [chosen, setChosen] = useState('');
  const current = choices.some((choice) => choice.id === chosen) ? chosen : (choices[0]?.id ?? '');
  if (pins.length >= MAX_HOME_PINS) {
    return (
      <p className="muted">{`O início guarda até ${String(MAX_HOME_PINS)} painéis. Tire um para fixar outro.`}</p>
    );
  }
  if (choices.length === 0) return null;
  return (
    <div className="home-pick">
      <Select
        label="Fixar o painel de uma lista"
        value={current}
        options={choices.map((choice) => ({ value: choice.id, label: choice.label }))}
        onChange={setChosen}
        disabled={busy}
      />
      <Button
        variant="quiet"
        busy={busy}
        onClick={() => {
          onPin(current);
        }}
      >
        Fixar
      </Button>
    </div>
  );
}
