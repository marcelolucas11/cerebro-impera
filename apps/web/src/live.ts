import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';

/*
 * Live updates for the open page. The server only says what changed (a
 * list, an item, your notifications, your access); the page then asks again
 * through the usual routes. Changes that arrive close together are read once.
 */

export interface LiveEvent {
  list?: string;
  item?: string;
  notifications?: true;
  access?: true;
}

export interface Pending {
  ids: Set<string>;
  notifications: boolean;
  access: boolean;
}

export const nothingPending = (): Pending => ({
  ids: new Set(),
  notifications: false,
  access: false,
});

/** Adds one event to what is waiting to be read again. Anything else is ignored. */
export function gather(pending: Pending, raw: unknown): Pending {
  if (typeof raw !== 'object' || raw === null) return pending;
  const event = raw as Record<string, unknown>;
  if (typeof event.list === 'string') pending.ids.add(event.list);
  if (typeof event.item === 'string') pending.ids.add(event.item);
  if (event.notifications === true) pending.notifications = true;
  if (event.access === true) pending.access = true;
  return pending;
}

/** Whether a cached question is about something that changed. */
export function touches(key: QueryKey, pending: Pending): boolean {
  if (pending.access) return true;
  if (pending.notifications && (key[0] === 'notifications' || key[0] === 'notifications-unread')) {
    return true;
  }
  return key.some((part) => typeof part === 'string' && pending.ids.has(part));
}

const SETTLE_MS = 300;

/** Opens the stream while signed in; the browser reconnects by itself when it drops. */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const source = new EventSource('/api/events');
    let pending = nothingPending();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      const now = pending;
      pending = nothingPending();
      timer = undefined;
      void queryClient.invalidateQueries({ predicate: (query) => touches(query.queryKey, now) });
    };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        pending = gather(pending, JSON.parse(message.data));
      } catch {
        return;
      }
      timer ??= setTimeout(flush, SETTLE_MS);
    };
    return () => {
      source.close();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queryClient]);
}
