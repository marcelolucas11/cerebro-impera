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
  // A list itself changed (not one of its items): it may have become sensitive,
  // been archived or moved, so the structure is read again.
  structure: boolean;
  notifications: boolean;
  access: boolean;
}

export const nothingPending = (): Pending => ({
  ids: new Set(),
  structure: false,
  notifications: false,
  access: false,
});

/** Adds one event to what is waiting to be read again. Anything else is ignored. */
export function gather(pending: Pending, raw: unknown): Pending {
  if (typeof raw !== 'object' || raw === null) return pending;
  const event = raw as Record<string, unknown>;
  if (typeof event.list === 'string') pending.ids.add(event.list);
  if (typeof event.item === 'string') pending.ids.add(event.item);
  else if (typeof event.list === 'string') pending.structure = true;
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
  // The start page gathers items from every list: any change may move it.
  if (key[0] === 'home') return pending.ids.size > 0;
  if (key[0] === 'tree') return pending.structure;
  return key.some((part) => typeof part === 'string' && pending.ids.has(part));
}

const SETTLE_MS = 300;

/** Waits before opening the stream again after the server refused it, doubling up to 5 minutes. */
export function nextRetry(previousMs: number): number {
  return Math.min(Math.max(previousMs * 2, FIRST_RETRY_MS), LAST_RETRY_MS);
}
const FIRST_RETRY_MS = 15_000;
const LAST_RETRY_MS = 5 * 60_000;

/**
 * Opens the stream while signed in. The browser reconnects by itself when the
 * connection drops; when the server refuses it (too many streams or requests),
 * the page tries again later and, once back, reads everything again.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let source: EventSource | undefined;
    let pending = nothingPending();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let waitMs = 0;
    let missed = false;
    const flush = (): void => {
      const now = pending;
      pending = nothingPending();
      timer = undefined;
      void queryClient.invalidateQueries({ predicate: (query) => touches(query.queryKey, now) });
    };
    const open = (): void => {
      retry = undefined;
      const current = new EventSource('/api/events');
      source = current;
      current.onopen = () => {
        waitMs = 0;
        if (missed) {
          missed = false;
          void queryClient.invalidateQueries();
        }
      };
      current.onmessage = (message: MessageEvent<string>) => {
        try {
          pending = gather(pending, JSON.parse(message.data));
        } catch {
          return;
        }
        timer ??= setTimeout(flush, SETTLE_MS);
      };
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED) return;
        missed = true;
        waitMs = nextRetry(waitMs);
        retry = setTimeout(open, waitMs);
      };
    };
    open();
    return () => {
      source?.close();
      if (timer !== undefined) clearTimeout(timer);
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [queryClient]);
}
