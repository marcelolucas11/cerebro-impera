import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type AppNotification } from '../api.js';
import { DEFAULT_SORT, NO_FILTER, toSearch } from '../filters.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { noticeSentence } from '../notices.js';
import { navigate } from '../router.js';
import { Button, Notice, useAction } from '../ui/kit.js';

const PAGE = 50;

/** How many are waiting to be read; checked every minute while the page is open. */
export function useUnreadNotifications(): number {
  const unread = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: api.unreadNotifications,
    refetchInterval: 60_000,
  });
  return unread.data?.unread ?? 0;
}

/*
 * What happened that this person should know of, newest first. Opening one
 * marks it read and leads to its item; notifications about items they no
 * longer see are not shown.
 */
export function Notifications(): ReactNode {
  const queryClient = useQueryClient();
  const latest = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications() });
  const [older, setOlder] = useState<AppNotification[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const found = [...(latest.data ?? []), ...older];
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    await queryClient.invalidateQueries({ queryKey: ['notifications-unread'] });
  }, [queryClient]);
  const readAll = useAction(
    useCallback(async () => {
      await api.readNotifications();
      const now = new Date().toISOString();
      setOlder((current) => current.map((one) => ({ ...one, readAt: one.readAt ?? now })));
      await refresh();
    }, [refresh]),
  );
  const open = useAction(
    useCallback(
      async (notice: AppNotification) => {
        if (notice.readAt === null) await api.readNotifications([notice.id]);
        await refresh();
        navigate(
          `/listas/${notice.listId}${toSearch({ ...NO_FILTER, text: notice.itemTitle }, DEFAULT_SORT)}`,
        );
      },
      [refresh],
    ),
  );
  const lastId = found.at(-1)?.id;
  const more = useAction(
    useCallback(async () => {
      if (lastId === undefined) return;
      const page = await api.notifications(lastId);
      setOlder((current) => [...current, ...page]);
      if (page.length < PAGE) setExhausted(true);
    }, [lastId]),
  );
  const unread = found.filter((one) => one.readAt === null).length;

  return (
    <>
      <h1>Avisos</h1>
      <p className="lead">
        Menções, itens que chegaram para você, comentários nos seus itens, prazos de hoje ou
        atrasados e o que uma automação pediu que você visse.
      </p>
      {latest.isError ? <Notice tone="error">{describeError(latest.error)}</Notice> : null}
      {latest.isPending ? <p className="field-note">Abrindo…</p> : null}
      {unread > 0 ? (
        <Button variant="quiet" busy={readAll.busy} onClick={readAll.run}>
          Marcar todos como lidos
        </Button>
      ) : null}
      {found.length === 0 && !latest.isPending ? (
        <p className="field-note">Nenhum aviso por enquanto.</p>
      ) : null}
      <ol className="notices">
        {found.map((notice) => (
          <li
            key={notice.id}
            className={notice.readAt === null ? 'notice-item is-unread' : 'notice-item'}
          >
            <button
              type="button"
              className="notice-open"
              onClick={() => {
                open.run(notice);
              }}
            >
              {noticeSentence(notice)}
              {notice.readAt === null ? <span className="visually-hidden"> (não lido)</span> : null}
            </button>
            <span className="muted">{formatWhen(notice.createdAt)}</span>
          </li>
        ))}
      </ol>
      {open.error ? <Notice tone="error">{open.error}</Notice> : null}
      {readAll.error ? <Notice tone="error">{readAll.error}</Notice> : null}
      {(latest.data?.length ?? 0) === PAGE && !exhausted ? (
        <Button variant="quiet" busy={more.busy} onClick={more.run}>
          Ver avisos mais antigos
        </Button>
      ) : null}
    </>
  );
}
