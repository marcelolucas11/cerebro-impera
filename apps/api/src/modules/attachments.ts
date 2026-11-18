import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Actor } from '../actor.js';
import { inTransaction, one, rows, run, sql, type Tx } from '../db.js';
import type { Deps } from '../deps.js';
import { detectType } from '../files/sniff.js';
import { openPart, PART_SIZE, partCount, partLength, sealPart } from '../files/store.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { openItem, openList } from './structure.js';

/*
 * Attachments follow their item: whoever sees the item sees them, whoever
 * edits it attaches and removes. Content is sent in parts, sealed part by
 * part, and only becomes downloadable once the antivirus has seen it.
 */

export interface AttachmentView {
  id: string;
  itemId: string;
  name: string;
  size: number;
  /** What the content is, read from it; null when it is none of the known types. */
  type: string | null;
  status: 'uploading' | 'scanning' | 'ready' | 'blocked';
  /** False when the installation runs without an antivirus. */
  scanned: boolean;
  createdBy: string;
  createdAt: Date;
  trashedAt: Date | null;
}

interface AttachmentRow {
  id: string;
  item_id: string;
  name: string;
  size: string;
  detected_type: string | null;
  status: AttachmentView['status'];
  scan_result: string | null;
  created_by: string;
  created_at: Date;
  deleted_at: Date | null;
}

const COLUMNS = `id, item_id, name, size, detected_type, status, scan_result, created_by,
  created_at, deleted_at`;

const toView = (row: AttachmentRow): AttachmentView => ({
  id: row.id,
  itemId: row.item_id,
  name: row.name,
  size: Number(row.size),
  type: row.detected_type,
  status: row.status,
  scanned: row.scan_result === 'clean' || row.scan_result === 'infected',
  createdBy: row.created_by,
  createdAt: row.created_at,
  trashedAt: row.deleted_at,
});

const notReady = (): HttpError => new HttpError(503, 'attachments_not_ready');

async function findAttachment(tx: Tx, attachmentId: string): Promise<AttachmentRow | undefined> {
  return one<AttachmentRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.attachments WHERE id = $1`,
    values: [attachmentId],
  });
}

/** The attachment and its item, when the caller may reach it at the given level. */
async function openAttachment(
  tx: Tx,
  actor: Actor,
  attachmentId: string,
  minimum: 'view' | 'edit',
): Promise<AttachmentRow> {
  const row = await findAttachment(tx, attachmentId);
  if (!row) throw notFound();
  await openItem(tx, actor, row.item_id, minimum);
  return row;
}

export async function listAttachments(
  tx: Tx,
  actor: Actor,
  itemId: string,
  options: { inTrash: boolean },
): Promise<AttachmentView[]> {
  await openItem(tx, actor, itemId, 'view');
  const found = await rows<AttachmentRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.attachments
           WHERE item_id = $1 AND (deleted_at IS NOT NULL) = $2
           ORDER BY created_at, id`,
    values: [itemId, options.inTrash],
  });
  return found.map(toView);
}

/**
 * One attachment, asked for through its list. Going through the list first is
 * what lets a sensitive list ask for the second factor instead of answering
 * "not found", so the page can confirm the code before a download starts.
 */
export async function attachmentInList(
  tx: Tx,
  actor: Actor,
  listId: string,
  attachmentId: string,
): Promise<AttachmentView> {
  await openList(tx, actor, listId, 'view');
  const row = await findAttachment(tx, attachmentId);
  if (!row) throw notFound();
  const { item } = await openItem(tx, actor, row.item_id, 'view');
  if (item.listId !== listId) throw notFound();
  return toView(row);
}

/** Opens an upload. Content follows in parts of PART_SIZE bytes. */
export async function startUpload(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: { name: string; size: number; type: string },
): Promise<{ id: string; partSize: number; parts: number }> {
  if (deps.scanner === null) throw notReady();
  await openItem(tx, actor, itemId, 'edit');
  if (body.size > deps.config.files.maxBytes) {
    throw badRequest('file_too_large', { maxBytes: deps.config.files.maxBytes });
  }
  // Keep a margin: a full disk would stop the database too.
  if ((await deps.files.freeBytes()) < body.size + 512 * 1024 * 1024) throw conflict('disk_full');
  const id = randomUUID();
  const wrapped = deps.vault.seal('attachment-key', id, randomBytes(32));
  await run(
    tx,
    sql`INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key)
        VALUES (${id}, ${itemId}, ${body.name}, ${body.size}, ${body.type}, ${wrapped})`,
  );
  return { id, partSize: PART_SIZE, parts: partCount(body.size) };
}

/** The sender's own open upload, with what is needed to seal its parts. */
async function openUpload(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  uploadId: string,
): Promise<{ size: number; key: Buffer }> {
  const row = await one<{ size: string; wrapped_key: Buffer; created_by: string; status: string }>(
    tx,
    sql`SELECT size, wrapped_key, created_by, status FROM app.attachments WHERE id = ${uploadId}`,
  );
  if (!row || row.created_by !== actor.userId) throw notFound();
  if (row.status !== 'uploading') throw conflict('upload_finished');
  return {
    size: Number(row.size),
    key: deps.vault.open('attachment-key', uploadId, row.wrapped_key),
  };
}

export async function receivePart(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  uploadId: string,
  n: number,
  content: Buffer,
): Promise<UploadState> {
  const { size, key } = await openUpload(deps, tx, actor, uploadId);
  const expected = partLength(size, n);
  if (expected === 0) throw badRequest('invalid_part');
  if (content.length !== expected) throw badRequest('invalid_part_size', { expected });
  await deps.files.writePart(uploadId, n, sealPart(key, uploadId, n, content));
  await run(
    tx,
    sql`INSERT INTO app.attachment_parts (attachment_id, n, size) VALUES (${uploadId}, ${n}, ${content.length})
        ON CONFLICT (attachment_id, n) DO UPDATE SET size = EXCLUDED.size`,
  );
  return uploadState(deps, tx, actor, uploadId);
}

/** Where an upload stands: enough for the page to continue it, even after a reload. */
export interface UploadState {
  partSize: number;
  parts: number;
  received: number[];
}

export async function uploadState(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  uploadId: string,
): Promise<UploadState> {
  const { size } = await openUpload(deps, tx, actor, uploadId);
  const parts = await rows<{ n: number }>(
    tx,
    sql`SELECT n FROM app.attachment_parts WHERE attachment_id = ${uploadId} ORDER BY n`,
  );
  return { partSize: PART_SIZE, parts: partCount(size), received: parts.map((part) => part.n) };
}

/** Every part of an attachment, opened, in order. */
async function* contentOf(
  deps: Deps,
  attachmentId: string,
  size: number,
  key: Buffer,
  from = 0,
): AsyncGenerator<Buffer> {
  for (let n = Math.floor(from / PART_SIZE); n < partCount(size); n += 1) {
    yield openPart(key, attachmentId, n, await deps.files.readPart(attachmentId, n));
  }
}

/**
 * Closes an upload once every part is in. The content is read back in full to
 * compute its digest and type. `scan` hands it to the antivirus, and must be
 * called only after this transaction has committed: before that, the database
 * would refuse the antivirus's answer for a file that is not yet waiting for it.
 */
export async function finishUpload(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  uploadId: string,
  log: (error: unknown) => void,
): Promise<{ attachment: AttachmentView; scan: () => void }> {
  const { size, key } = await openUpload(deps, tx, actor, uploadId);
  const digest = createHash('sha256');
  let head: Buffer | null = null;
  try {
    for await (const chunk of contentOf(deps, uploadId, size, key)) {
      head ??= chunk.subarray(0, 64);
      digest.update(chunk);
    }
  } catch {
    // A missing or damaged part: the database will say which are missing.
    throw conflict('parts_missing');
  }
  await run(
    tx,
    sql`SELECT app.finish_upload(${uploadId}, ${digest.digest()}, ${head ? detectType(head) : null})`,
  );
  const row = await findAttachment(tx, uploadId);
  if (!row) throw notFound();
  return {
    attachment: toView(row),
    scan: () => {
      scanLater(deps, uploadId, size, key, log);
    },
  };
}

/** Attachments this process is handing to the antivirus right now. */
const inFlight = new Set<string>();

function scanLater(
  deps: Deps,
  attachmentId: string,
  size: number,
  key: Buffer,
  log: (error: unknown) => void,
): void {
  const scanner = deps.scanner;
  if (scanner === null || inFlight.has(attachmentId)) return;
  inFlight.add(attachmentId);
  setImmediate(() => {
    scanner
      .scan(contentOf(deps, attachmentId, size, key))
      .then((result) =>
        inTransaction(deps.pools.app, (tx) =>
          run(tx, sql`SELECT app.record_scan(${attachmentId}, ${result})`),
        ),
      )
      .catch(log)
      .finally(() => {
        inFlight.delete(attachmentId);
      });
  });
}

/**
 * Hands to the antivirus whatever is still waiting: after a restart, or after
 * the antivirus was unreachable for a while. Runs at start and every hour.
 */
export async function resumeScans(deps: Deps, log: (error: unknown) => void): Promise<number> {
  if (deps.scanner === null) return 0;
  const waiting = await inTransaction(deps.pools.app, (tx) =>
    rows<{ id: string; size: string; wrapped_key: Buffer }>(
      tx,
      sql`SELECT id, size, wrapped_key FROM app.attachments_waiting_for_scan()`,
    ),
  );
  for (const row of waiting) {
    scanLater(
      deps,
      row.id,
      Number(row.size),
      deps.vault.open('attachment-key', row.id, row.wrapped_key),
      log,
    );
  }
  return waiting.length;
}

export async function cancelUpload(tx: Tx, actor: Actor, uploadId: string): Promise<void> {
  const row = await findAttachment(tx, uploadId);
  if (!row || row.created_by !== actor.userId) throw notFound();
  if (row.status !== 'uploading') throw conflict('upload_finished');
  await run(tx, sql`SELECT app.cancel_upload(${uploadId})`);
}

export async function trashAttachment(tx: Tx, actor: Actor, attachmentId: string): Promise<void> {
  const row = await openAttachment(tx, actor, attachmentId, 'edit');
  if (row.status === 'uploading') throw conflict('upload_unfinished');
  if (row.deleted_at !== null) throw notFound();
  const changed = await run(
    tx,
    sql`UPDATE app.attachments SET deleted_at = now() WHERE id = ${attachmentId}`,
  );
  if (changed !== 1) throw forbidden();
}

export async function restoreAttachment(
  tx: Tx,
  actor: Actor,
  attachmentId: string,
): Promise<AttachmentView> {
  const row = await openAttachment(tx, actor, attachmentId, 'edit');
  if (row.deleted_at === null) throw conflict('not_in_trash');
  const changed = await run(
    tx,
    sql`UPDATE app.attachments SET deleted_at = NULL WHERE id = ${attachmentId}`,
  );
  if (changed !== 1) throw forbidden();
  const restored = await findAttachment(tx, attachmentId);
  if (!restored) throw notFound();
  return toView(restored);
}

export interface Download {
  name: string;
  size: number;
  type: string | null;
  /** The bytes from `start` to `end`, inclusive. */
  start: number;
  end: number;
  chunks: AsyncIterable<Buffer>;
}

/** Content for whoever may see the item, once it is ready. */
export async function download(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  attachmentId: string,
  range: { start: number; end: number } | null,
): Promise<Download> {
  const row = await openAttachment(tx, actor, attachmentId, 'view');
  if (row.deleted_at !== null || row.status === 'uploading') throw notFound();
  if (row.status === 'scanning') throw conflict('attachment_scanning');
  if (row.status === 'blocked') throw conflict('attachment_blocked');
  const keyRow = await one<{ wrapped_key: Buffer; is_sensitive: boolean; list_id: string }>(
    tx,
    sql`SELECT a.wrapped_key, l.is_sensitive, l.id AS list_id
        FROM app.attachments a JOIN app.items i ON i.id = a.item_id JOIN app.lists l ON l.id = i.list_id
        WHERE a.id = ${attachmentId}`,
  );
  if (!keyRow) throw notFound();
  if (keyRow.is_sensitive) {
    await run(tx, sql`SELECT audit.record('attachment.downloaded', 'attachment', ${attachmentId})`);
  }
  const size = Number(row.size);
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? size - 1, size - 1);
  if (start > end || start >= size) throw new HttpError(416, 'range_not_satisfiable');
  const key = deps.vault.open('attachment-key', attachmentId, keyRow.wrapped_key);
  const parts = contentOf(deps, attachmentId, size, key, start);
  // The first part is opened before answering: content that was tampered with
  // fails the request instead of starting a download that breaks halfway.
  const first = await parts.next();
  async function* slice(): AsyncGenerator<Buffer> {
    let position = Math.floor(start / PART_SIZE) * PART_SIZE;
    let current = first;
    while (current.done !== true) {
      const part = current.value;
      const from = Math.max(start - position, 0);
      const to = Math.min(end - position + 1, part.length);
      if (from < to) yield part.subarray(from, to);
      position += part.length;
      if (position > end) return;
      current = await parts.next();
    }
  }
  return { name: row.name, size, type: row.detected_type, start, end, chunks: slice() };
}

/** Housekeeping: old uploads and expired removals go, and their content is wiped. */
export async function purgeAttachments(deps: Deps): Promise<number> {
  const purged = await inTransaction(deps.pools.app, async (tx) => {
    const result = await one<{ purged: number }>(tx, sql`SELECT app.purge_attachments() AS purged`);
    return result?.purged ?? 0;
  });
  for (;;) {
    const batch = await inTransaction(deps.pools.app, (tx) =>
      rows<{ id: string }>(tx, sql`SELECT take_disposals AS id FROM app.take_disposals(100)`),
    );
    for (const { id } of batch) await deps.files.remove(id);
    if (batch.length < 100) break;
  }
  return purged;
}
