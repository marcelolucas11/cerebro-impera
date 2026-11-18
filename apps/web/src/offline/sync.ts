import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError, type Item, type Stage } from '../api.js';
import { describeError } from '../messages.js';
import {
  applied,
  enqueue,
  expectationOf,
  queueable,
  type OfflineChange,
  type QueuedChange,
} from './queue.js';
import { FORGOTTEN, keptItem, keptValue, readQueue, rekeep, writeQueue } from './store.js';

/*
 * The queue of changes made without a connection: kept sealed on the device
 * with everything else (and forgotten with it), sent in order when the server
 * answers again, each with what the person saw. What the server refuses or
 * finds changed meanwhile stays on screen until the person decides.
 */

let entries: QueuedChange[] = [];
let loaded = false;
let flushing = false;
const watchers = new Set<() => void>();

function publish(next: QueuedChange[]): void {
  entries = next;
  for (const watcher of watchers) watcher();
}

if (typeof window !== 'undefined') {
  window.addEventListener(FORGOTTEN, () => {
    loaded = false;
    publish([]);
  });
}

async function load(): Promise<QueuedChange[]> {
  if (!loaded) {
    publish(await readQueue<QueuedChange>());
    loaded = true;
  }
  return entries;
}

async function save(next: QueuedChange[]): Promise<void> {
  publish(next);
  await writeQueue(next);
}

export function useQueuedChanges(): QueuedChange[] {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
    () => entries,
  );
}

/**
 * Changes an item. Without a connection, a change to its plain facts waits on
 * the device, and what the device shows already reads with it.
 */
export async function changeItem(
  itemId: string,
  change: Parameters<typeof api.updateItem>[1],
): Promise<Item> {
  try {
    return await api.updateItem(itemId, change);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'network' || !queueable(change)) throw error;
    const kept = await keptItem(itemId);
    const item = kept?.items.find((candidate) => candidate.id === itemId) as Item | undefined;
    if (kept === null || item === undefined) throw error;
    const stages = (await keptValue(`/api/lists/${item.listId}/stages`)) as Stage[] | undefined;
    await save(
      enqueue(await load(), {
        id: crypto.randomUUID(),
        itemId,
        listId: item.listId,
        itemTitle: item.title,
        change,
        expected: expectationOf(item, change),
        stageNames: Object.fromEntries((stages ?? []).map((stage) => [stage.id, stage.name])),
        madeAt: Date.now(),
        state: 'waiting',
      }),
    );
    const next = applied(item, change);
    await rekeep(
      kept.path,
      kept.items.map((candidate) => (candidate.id === itemId ? next : candidate)),
      kept.at,
    );
    return next;
  }
}

function settled(entry: QueuedChange, error: unknown): QueuedChange {
  if (error instanceof ApiError && error.code === 'changed_meanwhile') {
    return { ...entry, state: 'conflict', current: error.details.current as OfflineChange };
  }
  return { ...entry, state: 'refused', reason: describeError(error) };
}

/** Sends what waits, in order, until the server cannot be reached. True when anything moved. */
export async function flush(): Promise<boolean> {
  if (flushing) return false;
  flushing = true;
  let moved = false;
  try {
    for (const entry of await load()) {
      if (entry.state !== 'waiting') continue;
      try {
        await api.updateItem(entry.itemId, { ...entry.change, expected: entry.expected });
        await save(entries.filter((one) => one.id !== entry.id));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'network') break;
        await save(entries.map((one) => (one.id === entry.id ? settled(one, error) : one)));
      }
      moved = true;
    }
  } finally {
    flushing = false;
  }
  return moved;
}

/** In a conflict: write the person's version over what is there now. */
export async function keepMine(id: string): Promise<void> {
  const entry = entries.find((one) => one.id === id);
  if (entry === undefined) return;
  try {
    await api.updateItem(entry.itemId, entry.change);
    await save(entries.filter((one) => one.id !== id));
  } catch (error) {
    if (error instanceof ApiError && error.code === 'network') throw error;
    await save(entries.map((one) => (one.id === id ? settled({ ...one }, error) : one)));
  }
}

/** Lets go of a change that conflicted or was refused: what is on the server stays. */
export async function dismiss(id: string): Promise<void> {
  await save(entries.filter((one) => one.id !== id));
}

/** While the app is open: sends what waits now, when the connection returns, and every few seconds. */
export function useOfflineSync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let alive = true;
    const run = (): void => {
      void flush().then((moved) => {
        if (moved && alive) void queryClient.invalidateQueries();
      });
    };
    void load().then(run);
    window.addEventListener('online', run);
    const timer = setInterval(() => {
      if (entries.some((entry) => entry.state === 'waiting')) run();
    }, 5_000);
    return () => {
      alive = false;
      window.removeEventListener('online', run);
      clearInterval(timer);
    };
  }, [queryClient]);
}
