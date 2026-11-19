import { useSyncExternalStore } from 'react';
import type { Tree } from '../api.js';
import { expired, keepable, keptPart, listOf, noLongerKeepable } from './policy.js';
import { newKey, seal, unseal, type Sealed } from './vault.js';

/*
 * What this device keeps to read offline, in IndexedDB, every record sealed
 * (see vault.ts). Written after each answer the server gives; read only when
 * the server cannot be reached. Forgotten on signing out, when the session
 * ends, on signing in, and after days without talking to the server, in every
 * open tab at once. A list the person no longer sees as before (gone, now
 * sensitive, another level or reach, or refused by the server) is dropped as
 * soon as the page learns it. A device can also be told to keep nothing.
 * Anything going wrong here only means less is kept: the app works as before.
 */

const DATABASE = 'cerebro-offline';
const KEYS = 'keys';
const RECORDS = 'records';
const META = 'meta';

interface Record_ extends Sealed {
  savedAt: number;
}

let opening: Promise<IDBDatabase | null> | null = null;
let key: Promise<CryptoKey | null> | null = null;
// The structure the person sees, as last answered by the server in this page.
let tree: Tree | null = null;
// Moves on every time everything is forgotten: an answer asked for before that is not kept.
let era = 0;
// Nothing is kept until the server has said who is signed in, in this era.
let signedIn = false;

/** Taken when a request starts, and handed back to `remember` with its answer. */
export function currentEra(): number {
  return era;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb'));
    };
  });
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const store of [KEYS, RECORDS, META]) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another page forgetting everything: let go, so the database can be removed.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      resolve(null);
    };
    request.onblocked = () => {
      resolve(null);
    };
  });
  return opening;
}

async function read<T>(store: string, slot: string): Promise<T | undefined> {
  const db = await database();
  if (db === null) return undefined;
  return done(db.transaction(store, 'readonly').objectStore(store).get(slot)) as Promise<
    T | undefined
  >;
}

async function slots(): Promise<string[]> {
  const db = await database();
  if (db === null) return [];
  return (await done(db.transaction(RECORDS, 'readonly').objectStore(RECORDS).getAllKeys())).map(
    String,
  );
}

async function remove(slotsToGo: readonly string[]): Promise<void> {
  const db = await database();
  if (db === null || slotsToGo.length === 0) return;
  const store = db.transaction(RECORDS, 'readwrite').objectStore(RECORDS);
  await Promise.all(slotsToGo.map((slot) => done(store.delete(slot))));
}

async function write(store: string, slot: string, value: unknown): Promise<void> {
  const db = await database();
  if (db === null) return;
  await done(db.transaction(store, 'readwrite').objectStore(store).put(value, slot));
}

/** The device's key: made once, never readable, kept with the records it locks. */
function deviceKey(): Promise<CryptoKey | null> {
  key ??= (async () => {
    const kept = await read<CryptoKey>(KEYS, 'main');
    if (kept !== undefined) return kept;
    const made = await newKey();
    await write(KEYS, 'main', made);
    return made;
  })().catch(() => null);
  return key;
}

// ---- Whether what is on screen came from this device ------------------------------

let servedSince: number | null = null;
const watchers = new Set<() => void>();

function served(at: number | null): void {
  if (servedSince === at) return;
  servedSince = at;
  for (const watcher of watchers) watcher();
}

/** When what is shown was kept (the oldest such moment), or null when it came from the server. */
export function useServedFromDevice(): number | null {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
    () => servedSince,
  );
}

// ---- Whether this device keeps anything at all ----------------------------------

const SWITCH = 'cerebro:offline';

/** False on a device told to keep nothing (a shared computer, say). The choice is the device's. */
export function keepsOffline(): boolean {
  try {
    return localStorage.getItem(SWITCH) !== 'off';
  } catch {
    return true;
  }
}

/** Turns keeping on or off for this device; off forgets everything at once. */
export async function setKeepsOffline(on: boolean): Promise<void> {
  try {
    if (on) localStorage.removeItem(SWITCH);
    else localStorage.setItem(SWITCH, 'off');
  } catch {
    // Without storage the choice does not last; what was kept still goes.
  }
  if (!on) await forget();
}

// ---- Called by the API client -----------------------------------------------------

/**
 * Keeps a fresh answer, if it may be kept; and notes that the server answered.
 * An answer to a request made before the device last forgot everything (a
 * sign-out, say) is dropped.
 */
export async function remember(path: string, value: unknown, askedIn: number): Promise<void> {
  if (askedIn !== era) return;
  served(null);
  if (path === '/api/me') signedIn = true;
  if (!signedIn || !keepsOffline()) return;
  if (path === '/api/tree') tree = value as Tree;
  try {
    await write(META, 'lastContact', Date.now());
    if (path === '/api/tree') {
      // What was kept of lists she no longer sees as before goes, before anything else.
      const before = (await readSealed('/api/tree').catch(() => null))?.value as Tree | undefined;
      await remove(
        (await slots()).filter((slot) => noLongerKeepable(slot, before ?? null, value as Tree)),
      );
    }
    if (!keepable(path, tree)) return;
    const lock = await deviceKey();
    if (lock === null) return;
    const sealed = await seal(lock, path, keptPart(path, value, tree));
    if (askedIn !== era) return;
    await write(RECORDS, path, { ...sealed, savedAt: Date.now() } satisfies Record_);
  } catch {
    // Less is kept; nothing else changes.
  }
}

/** What was kept for this address, unless the device has been away for too long. */
export async function recall(path: string): Promise<{ value: unknown } | null> {
  try {
    const lastContact = (await read<number>(META, 'lastContact')) ?? null;
    if (expired(lastContact, Date.now())) {
      await forget();
      return null;
    }
    if (listOf(path) !== undefined) {
      // Only a list the kept structure still shows, as it was then.
      const kept = (await readSealed('/api/tree'))?.value as Tree | undefined;
      if (!keepable(path, kept ?? null)) {
        await remove([path]);
        return null;
      }
    }
    const record = await read<Record_>(RECORDS, path);
    const lock = record === undefined ? null : await deviceKey();
    if (record === undefined || lock === null) return null;
    const value = await unseal(lock, path, record);
    if (value === undefined) return null;
    served(Math.min(servedSince ?? record.savedAt, record.savedAt));
    return { value };
  } catch {
    return null;
  }
}

/** The server refused this address (403 or 404): what was kept of it, and of its list, goes. */
export async function dropKept(path: string): Promise<void> {
  try {
    const list = listOf(path);
    await remove(
      list === undefined
        ? [path]
        : (await slots()).filter((slot) => slot === path || listOf(slot) === list),
    );
  } catch {
    // Nothing else to do: the next structure from the server prunes it too.
  }
}

/** At start: a device away from the server for too long forgets before showing anything. */
export async function sweep(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    const lastContact = (await read<number>(META, 'lastContact')) ?? null;
    if (expired(lastContact, Date.now()) || !keepsOffline()) await forget();
  } catch {
    // The first read offline checks again.
  }
}

// ---- Read and written by the queue of changes made offline -----------------------

async function readSealed(slot: string): Promise<{ value: unknown; savedAt: number } | null> {
  const record = await read<Record_>(RECORDS, slot);
  const lock = record === undefined ? null : await deviceKey();
  if (record === undefined || lock === null) return null;
  const value = await unseal(lock, slot, record);
  return value === undefined ? null : { value, savedAt: record.savedAt };
}

async function writeSealed(slot: string, value: unknown, savedAt: number): Promise<void> {
  const lock = await deviceKey();
  if (lock === null) throw new Error('no key');
  const sealed = await seal(lock, slot, value);
  await write(RECORDS, slot, { ...sealed, savedAt } satisfies Record_);
}

const LIST_ITEMS = /^\/api\/lists\/[0-9a-f-]{36}\/items$/;

/** An item as this device kept it, with the list it was kept in. */
export async function keptItem(
  itemId: string,
): Promise<{ path: string; items: { id: string }[]; at: number } | null> {
  const db = await database();
  if (db === null) return null;
  const slots = (await done(db.transaction(RECORDS, 'readonly').objectStore(RECORDS).getAllKeys()))
    .map(String)
    .filter((slot) => LIST_ITEMS.test(slot));
  for (const path of slots) {
    const kept = await readSealed(path);
    const items = kept?.value as { id: string }[] | undefined;
    if (kept !== null && Array.isArray(items) && items.some((item) => item.id === itemId)) {
      return { path, items, at: kept.savedAt };
    }
  }
  return null;
}

/** What this device kept for an address, as it was kept (no expiry, no notice on screen). */
export async function keptValue(path: string): Promise<unknown> {
  return (await readSealed(path))?.value;
}

/** Writes over what was kept for an address, keeping the moment it came from the server. */
export async function rekeep(path: string, value: unknown, savedAt: number): Promise<void> {
  await writeSealed(path, value, savedAt);
}

const QUEUE = 'queue';

export async function readQueue<T>(): Promise<T[]> {
  try {
    const kept = await readSealed(QUEUE);
    return Array.isArray(kept?.value) ? (kept.value as T[]) : [];
  } catch {
    return [];
  }
}

export async function writeQueue(entries: readonly unknown[]): Promise<void> {
  await writeSealed(QUEUE, entries, Date.now());
}

/** Removes everything this device kept, the key included. */
export const FORGOTTEN = 'cerebro:offline-forgotten';

// Every open tab of the app forgets together: one that signs out, or is signed
// out, tells the others, which drop what they hold in memory and keep nothing
// they were about to.
const others: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cerebro-offline');
if (others !== null) {
  others.onmessage = (event: MessageEvent) => {
    if (event.data === 'forget') void forgetHere();
  };
}

export async function forget(): Promise<void> {
  others?.postMessage('forget');
  await forgetHere();
}

async function forgetHere(): Promise<void> {
  era += 1;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FORGOTTEN));
  signedIn = false;
  tree = null;
  key = null;
  served(null);
  const db = await (opening ?? Promise.resolve(null));
  opening = null;
  db?.close();
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
  });
}
