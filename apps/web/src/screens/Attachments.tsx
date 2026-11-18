import { previewKind } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, ApiError, type Attachment, type Item } from '../api.js';
import { formatBytes, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, useAction } from '../ui/kit.js';
import { beginUpload, continueUpload, sameFile, type UploadIo } from '../upload.js';

/*
 * Files of an item. Whoever sees the item sees them; whoever edits it sends
 * and removes them. Nothing is shown or downloaded before the antivirus has
 * answered, and what the page shows inline is only what cannot run anything.
 */

const io: UploadIo = {
  start: api.startUpload,
  state: api.uploadState,
  sendPart: api.sendPart,
  finish: api.finishUpload,
  wait: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

/** A file on its way up from this page. */
interface Sending {
  key: string;
  file: File;
  uploadId: string | null;
  sent: number;
  error: string | null;
  stop: AbortController | null;
}

const isStopped = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export function Attachments({
  item,
  canEdit,
  nameOf,
}: {
  item: Item;
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const pickId = useId();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const files = useQuery({
    queryKey: ['attachments', item.id],
    queryFn: () => api.attachments(item.id),
    // While the antivirus is looking at something, ask again every few seconds.
    refetchInterval: (query) =>
      query.state.data?.some((file) => file.status === 'scanning') === true ? 2000 : false,
  });
  const [sending, setSending] = useState<Sending[]>([]);
  const counter = useRef(0);

  const change = useCallback((key: string, patch: Partial<Sending>) => {
    setSending((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }, []);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['attachments', item.id] });
    await queryClient.invalidateQueries({ queryKey: ['item-history', item.id] });
  }, [item.id, queryClient]);

  /** Sends one file, from wherever it stopped. Failures stay on screen with a way to continue. */
  const run = useCallback(
    async (entry: Sending): Promise<void> => {
      const stop = new AbortController();
      change(entry.key, { stop, error: null });
      let uploadId = entry.uploadId;
      try {
        if (uploadId === null) {
          uploadId = await beginUpload(io, item.id, entry.file);
          change(entry.key, { uploadId });
        }
        await continueUpload(
          io,
          uploadId,
          entry.file,
          (sent) => {
            change(entry.key, { sent });
          },
          stop.signal,
        );
        setSending((current) => current.filter((other) => other.key !== entry.key));
        await refresh();
      } catch (error) {
        if (isStopped(error)) {
          if (uploadId !== null) await api.cancelUpload(uploadId).catch(() => undefined);
          setSending((current) => current.filter((other) => other.key !== entry.key));
          await refresh();
          return;
        }
        change(entry.key, { stop: null, error: describeError(error) });
      }
    },
    [change, item.id, refresh],
  );

  const queue = useCallback(
    async (chosen: { file: File; uploadId: string | null }[]): Promise<void> => {
      const entries = chosen.map(({ file, uploadId }) => {
        counter.current += 1;
        return { key: String(counter.current), file, uploadId, sent: 0, error: null, stop: null };
      });
      setSending((current) => [...current, ...entries]);
      // One at a time: on a phone connection, parallel uploads only slow each other down.
      for (const entry of entries) await run(entry);
    },
    [run],
  );

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    void queue(chosen.map((file) => ({ file, uploadId: null })));
  };

  const all = files.data ?? [];
  const mine = me.data?.user.id;
  const activeUploads = new Set(sending.map((entry) => entry.uploadId));
  const interrupted = all.filter(
    (file) => file.status === 'uploading' && file.createdBy === mine && !activeUploads.has(file.id),
  );
  const shown = all.filter((file) => file.status !== 'uploading');
  const empty = shown.length === 0 && sending.length === 0 && interrupted.length === 0;

  return (
    <div className="subsection">
      <h3>Anexos</h3>
      {files.isError ? <Notice tone="error">{describeError(files.error)}</Notice> : null}
      {empty && files.isSuccess ? <p className="field-note">Nenhum arquivo anexado.</p> : null}
      {!empty ? (
        <ul className="files">
          {shown.map((file) => (
            <AttachmentRow
              key={file.id}
              file={file}
              listId={item.listId}
              canEdit={canEdit}
              nameOf={nameOf}
              onChanged={refresh}
            />
          ))}
          {sending.map((entry) => (
            <SendingRow
              key={entry.key}
              entry={entry}
              onRetry={() => {
                void run(entry);
              }}
              onDiscard={() => {
                if (entry.stop) {
                  entry.stop.abort();
                  return;
                }
                setSending((current) => current.filter((other) => other.key !== entry.key));
                if (entry.uploadId !== null) {
                  void api
                    .cancelUpload(entry.uploadId)
                    .catch(() => undefined)
                    .then(refresh);
                }
              }}
            />
          ))}
          {interrupted.map((file) => (
            <InterruptedRow
              key={file.id}
              file={file}
              onContinue={(local) => queue([{ file: local, uploadId: file.id }])}
              onDiscarded={refresh}
            />
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <>
          <div className="actions">
            <label className="file-button" htmlFor={pickId}>
              Anexar arquivos<span className="visually-hidden"> a {item.title}</span>
            </label>
            <input id={pickId} className="visually-hidden" type="file" multiple onChange={pick} />
          </div>
          <p className="field-note">
            Cada arquivo passa pelo antivírus antes de poder ser aberto. Se a conexão cair, o envio
            continua de onde parou.
          </p>
          <AttachmentTrash item={item} onChanged={refresh} />
        </>
      ) : null}
    </div>
  );
}

function statusTag(file: Attachment): ReactNode {
  if (file.status === 'scanning') return <span className="tag">em verificação</span>;
  if (file.status === 'blocked') {
    return <span className="tag tag-danger">bloqueado pelo antivírus</span>;
  }
  if (!file.scanned) return <span className="tag">não verificado pelo antivírus</span>;
  return null;
}

/** A file that is in: download it, look at it in place when it is safe to, or remove it. */
function AttachmentRow({
  file,
  listId,
  canEdit,
  nameOf,
  onChanged,
}: {
  file: Attachment;
  listId: string;
  canEdit: boolean;
  nameOf: (userId: string | null) => string;
  onChanged: () => Promise<void>;
}): ReactNode {
  const guard = useGuard();
  const [showing, setShowing] = useState(false);
  const kind = previewKind(file.type);
  const ready = file.status === 'ready';

  /** Asked through the list first: a sensitive list asks for the code, and the state is current. */
  const confirm = useCallback(async () => {
    const fresh = await guard(() => api.attachmentInList(listId, file.id));
    if (fresh.status === 'blocked') throw new ApiError(409, 'attachment_blocked');
    if (fresh.status !== 'ready') throw new ApiError(409, 'attachment_scanning');
  }, [guard, listId, file.id]);

  const download = useAction(
    useCallback(async () => {
      await confirm();
      const link = document.createElement('a');
      link.href = api.attachmentUrl(file.id);
      link.download = file.name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
    }, [confirm, file.id, file.name]),
  );
  const show = useAction(
    useCallback(async () => {
      if (!showing) await confirm();
      setShowing(!showing);
    }, [confirm, showing]),
  );
  const trash = useAction(
    useCallback(async () => {
      await api.trashAttachment(file.id);
      await onChanged();
    }, [file.id, onChanged]),
  );
  const source = api.attachmentUrl(file.id, { inline: true });
  const error = download.error ?? show.error ?? trash.error;

  return (
    <li className="file">
      <div className="file-line">
        <span className="file-name">
          {file.name}
          {statusTag(file)}
        </span>
        <span className="muted">
          {formatBytes(file.size)}, enviado por {nameOf(file.createdBy)} em{' '}
          {formatWhen(file.createdAt)}
        </span>
      </div>
      <div className="file-actions">
        {ready ? (
          <Button variant="quiet" busy={download.busy} onClick={download.run}>
            Baixar<span className="visually-hidden"> {file.name}</span>
          </Button>
        ) : null}
        {ready && kind !== null ? (
          <Button variant="quiet" busy={show.busy} aria-expanded={showing} onClick={show.run}>
            {showing ? 'Fechar' : kind === 'image' ? 'Ver' : 'Tocar'}
            <span className="visually-hidden"> {file.name}</span>
          </Button>
        ) : null}
        {canEdit ? (
          <Button variant="quiet" busy={trash.busy} onClick={trash.run}>
            Mandar para a lixeira<span className="visually-hidden"> o anexo {file.name}</span>
          </Button>
        ) : null}
      </div>
      {showing && kind === 'image' ? (
        <img className="file-preview" src={source} alt={file.name} />
      ) : null}
      {showing && kind === 'audio' ? (
        <audio className="file-preview" src={source} controls preload="metadata" />
      ) : null}
      {showing && kind === 'video' ? (
        <video className="file-preview" src={source} controls preload="metadata" />
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </li>
  );
}

function SendingRow({
  entry,
  onRetry,
  onDiscard,
}: {
  entry: Sending;
  onRetry: () => void;
  onDiscard: () => void;
}): ReactNode {
  const percent = entry.file.size === 0 ? 100 : Math.floor((entry.sent / entry.file.size) * 100);
  return (
    <li className="file">
      <div className="file-line">
        <span className="file-name">{entry.file.name}</span>
        <span className="muted">
          {entry.error === null ? `Enviando, ${percent}%` : `Envio parado em ${percent}%`}
        </span>
      </div>
      <progress
        className="file-progress"
        value={entry.sent}
        max={Math.max(entry.file.size, 1)}
        aria-label={`Envio de ${entry.file.name}`}
      />
      {entry.error !== null ? <Notice tone="error">{entry.error}</Notice> : null}
      <div className="file-actions">
        {entry.error !== null ? (
          <Button variant="quiet" onClick={onRetry}>
            Continuar envio<span className="visually-hidden"> de {entry.file.name}</span>
          </Button>
        ) : null}
        <Button variant="quiet" onClick={onDiscard}>
          {entry.stop ? 'Parar envio' : 'Descartar envio'}
          <span className="visually-hidden"> de {entry.file.name}</span>
        </Button>
      </div>
    </li>
  );
}

/** An upload that stopped in another visit: the same file, chosen again, picks it up. */
function InterruptedRow({
  file,
  onContinue,
  onDiscarded,
}: {
  file: Attachment;
  onContinue: (local: File) => Promise<void>;
  onDiscarded: () => Promise<void>;
}): ReactNode {
  const pickId = useId();
  const [error, setError] = useState<string | null>(null);
  const discard = useAction(
    useCallback(async () => {
      await api.cancelUpload(file.id);
      await onDiscarded();
    }, [file.id, onDiscarded]),
  );
  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const local = event.target.files?.[0];
    event.target.value = '';
    if (!local) return;
    if (!sameFile(file, local)) {
      setError(describeError(new ApiError(400, 'not_same_file')));
      return;
    }
    setError(null);
    void onContinue(local);
  };
  return (
    <li className="file">
      <div className="file-line">
        <span className="file-name">
          {file.name}
          <span className="tag">envio interrompido</span>
        </span>
        <span className="muted">
          {formatBytes(file.size)}. Escolha o mesmo arquivo para continuar de onde parou. Sem isso,
          o envio é descartado em 24 horas.
        </span>
      </div>
      <div className="file-actions">
        <label className="file-button" htmlFor={pickId}>
          Escolher o arquivo para continuar<span className="visually-hidden"> {file.name}</span>
        </label>
        <input id={pickId} className="visually-hidden" type="file" onChange={pick} />
        <Button variant="quiet" busy={discard.busy} onClick={discard.run}>
          Descartar envio<span className="visually-hidden"> de {file.name}</span>
        </Button>
      </div>
      {(error ?? discard.error) ? <Notice tone="error">{error ?? discard.error}</Notice> : null}
    </li>
  );
}

/** Removed files of the item, for 30 days. Opened only when asked for. */
function AttachmentTrash({
  item,
  onChanged,
}: {
  item: Item;
  onChanged: () => Promise<void>;
}): ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const trashed = useQuery({
    queryKey: ['attachments', item.id, 'trash'],
    queryFn: () => api.attachments(item.id, { trash: true }),
    enabled: open,
  });
  const restore = useAction(
    useCallback(
      async (id: string) => {
        await api.restoreAttachment(id);
        await queryClient.invalidateQueries({ queryKey: ['attachments', item.id, 'trash'] });
        await onChanged();
      },
      [item.id, onChanged, queryClient],
    ),
  );
  if (!open) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        Ver anexos na lixeira
      </Button>
    );
  }
  const list = trashed.data ?? [];
  return (
    <div className="file-trash">
      <h4>Anexos na lixeira</h4>
      {trashed.isError ? <Notice tone="error">{describeError(trashed.error)}</Notice> : null}
      {trashed.isSuccess && list.length === 0 ? (
        <p className="field-note">Nenhum anexo na lixeira.</p>
      ) : null}
      <ul className="files">
        {list.map((file) => (
          <li key={file.id} className="file">
            <div className="file-line">
              <span className="file-name">{file.name}</span>
              <span className="muted">
                {formatBytes(file.size)}, removido em{' '}
                {file.trashedAt === null ? '' : formatWhen(file.trashedAt)}
              </span>
            </div>
            <div className="file-actions">
              <Button
                variant="quiet"
                busy={restore.busy}
                onClick={() => {
                  restore.run(file.id);
                }}
              >
                Restaurar<span className="visually-hidden"> o anexo {file.name}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {restore.error ? <Notice tone="error">{restore.error}</Notice> : null}
      <p className="field-note">Anexos ficam 30 dias na lixeira e depois são apagados de vez.</p>
    </div>
  );
}
