import { useSyncExternalStore } from 'react';
import type { Tree } from '../api.js';
import { expired, keepable, keptPart } from './policy.js';
import { newKey, seal, unseal, type Sealed } from './vault.js';

/*
 * What this device keeps to read offline, in IndexedDB, every record sealed
 * (see vault.ts). Written after each answer the server gives; read only when
 * the server cannot be reached. Forgotten on signing out, when the session
 * ends, on signing in, and after days without talking to the server.
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
  if (!signedIn) return;
  if (path === '/api/tree') tree = value as Tree;
  try {
    await write(META, 'lastContact', Date.now());
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

/** Removes everything this device kept, the key included. */
export async function forget(): Promise<void> {
  era += 1;
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
