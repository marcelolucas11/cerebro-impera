import type pg from 'pg';

/*
 * Live updates. The database announces which list and item changed, and whose
 * the item is; this hub listens once and passes each announcement only to the
 * open pages of people who can open that list, and, where they see only
 * their own items, only when the item is theirs. Pages then ask again through
 * the usual routes, so nothing here ever carries data.
 */

export const LIVE_CHANNEL = 'cerebro_live';

/** What the database announced. */
export interface Announcement {
  /** A list changed (its items, stages or fields). */
  l?: string;
  /** Which item, when it was one. */
  i?: string;
  /** Whose that item is: its creator and the people it is with. */
  p?: string[];
  /** Someone's notifications changed. */
  u?: string;
  /** Someone's access changed. */
  g?: string;
}

/** What a page is told. */
export interface LiveEvent {
  /** A list to read again. */
  list?: string;
  /** An item to read again, when the person may see it. */
  item?: string;
  /** Read your notifications again. */
  notifications?: true;
  /** Read what you can open again. */
  access?: true;
}

/** One open page: whose it is, and what they can open (list id → every item, or only theirs). */
export interface Listener {
  userId: string;
  lists: ReadonlyMap<string, 'all' | 'assigned'>;
  send: (event: LiveEvent) => void;
  /** Asked to look again at what this person can open. */
  refresh: () => void;
}

/** Who hears what. Kept apart from sockets so the rules can be tested on their own. */
export function deliver(announcement: Announcement, listeners: Iterable<Listener>): void {
  for (const listener of listeners) {
    if (announcement.u !== undefined && announcement.u === listener.userId) {
      listener.send({ notifications: true });
    }
    if (announcement.g !== undefined && announcement.g === listener.userId) {
      listener.refresh();
      listener.send({ access: true });
    }
    if (announcement.l === undefined) continue;
    const scope = listener.lists.get(announcement.l);
    if (scope === undefined) continue;
    if (announcement.i === undefined) {
      listener.send({ list: announcement.l });
    } else if (scope === 'all' || (announcement.p ?? []).includes(listener.userId)) {
      listener.send({ list: announcement.l, item: announcement.i });
    }
  }
}

/** Reads an announcement, or nothing when it is not one. */
export function parseAnnouncement(payload: string | undefined): Announcement | null {
  if (payload === undefined) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof raw[key] === 'string' ? raw[key] : undefined;
    const people = Array.isArray(raw.p)
      ? raw.p.filter((one): one is string => typeof one === 'string')
      : undefined;
    const found: Announcement = {};
    const list = text('l');
    const item = text('i');
    const user = text('u');
    const grant = text('g');
    if (list !== undefined) found.l = list;
    if (item !== undefined) found.i = item;
    if (people !== undefined) found.p = people;
    if (user !== undefined) found.u = user;
    if (grant !== undefined) found.g = grant;
    return found;
  } catch {
    return null;
  }
}

/** Open pages per person, at most. */
export const MAX_LISTENERS_PER_PERSON = 5;
/** How often an open page is reminded the stream is alive, and the session checked again. */
export const LIVE_HEARTBEAT_MS = 25_000;
/** Streams one session may open per minute: a page reconnecting now and then, never a loop. */
export const LIVE_OPENS_PER_MINUTE = 20;

/**
 * One connection to the database, opened when the first page listens and
 * kept while any does; reopened if it drops.
 */
export class LiveHub {
  readonly #pool: pg.Pool;
  readonly #listeners = new Set<Listener>();
  #client: pg.PoolClient | null = null;
  #connecting: Promise<void> | null = null;
  #closed = false;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  countFor(userId: string): number {
    let count = 0;
    for (const listener of this.#listeners) if (listener.userId === userId) count += 1;
    return count;
  }

  async add(listener: Listener): Promise<void> {
    this.#listeners.add(listener);
    await this.#connect();
  }

  remove(listener: Listener): void {
    this.#listeners.delete(listener);
    if (this.#listeners.size === 0) this.#release();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    this.#release();
    await Promise.resolve();
  }

  #connect(): Promise<void> {
    if (this.#client !== null || this.#closed) return Promise.resolve();
    this.#connecting ??= (async () => {
      const client = await this.#pool.connect();
      client.on('notification', (message) => {
        if (message.channel !== LIVE_CHANNEL) return;
        const announcement = parseAnnouncement(message.payload);
        if (announcement !== null) deliver(announcement, this.#listeners);
      });
      client.on('error', () => {
        // The connection dropped: open another while anyone listens.
        this.#client = null;
        client.release(true);
        if (this.#listeners.size > 0) setTimeout(() => void this.#connect(), 5_000).unref();
      });
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      this.#client = client;
    })().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #release(): void {
    const client = this.#client;
    if (client === null) return;
    this.#client = null;
    client.query(`UNLISTEN ${LIVE_CHANNEL}`).then(
      () => {
        client.release();
      },
      () => {
        client.release(true);
      },
    );
  }
}
