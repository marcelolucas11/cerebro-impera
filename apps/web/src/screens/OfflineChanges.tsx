import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import { conflictText } from '../offline/queue.js';
import { dismiss, keepMine, useQueuedChanges } from '../offline/sync.js';
import { Button, Notice, useAction } from '../ui/kit.js';

/*
 * What was changed without a connection and is not on the server yet: what
 * waits, and what needs the person to decide because someone else changed the
 * same thing meanwhile, or because the server did not accept it.
 */
export function OfflineChanges(): ReactNode {
  const queryClient = useQueryClient();
  const queued = useQueuedChanges();
  const decide = useAction(
    useCallback(
      async (id: string, mine: boolean) => {
        await (mine ? keepMine(id) : dismiss(id));
        await queryClient.invalidateQueries();
      },
      [queryClient],
    ),
  );
  if (queued.length === 0) return null;
  const waiting = queued.filter((entry) => entry.state === 'waiting').length;

  return (
    <section className="offline-changes" aria-label="Mudanças feitas sem conexão">
      {waiting > 0 ? (
        <p>
          {waiting === 1
            ? '1 mudança feita sem conexão espera para ser enviada.'
            : `${String(waiting)} mudanças feitas sem conexão esperam para ser enviadas.`}
        </p>
      ) : null}
      {decide.error ? <Notice tone="error">{decide.error}</Notice> : null}
      <ul className="offline-decisions">
        {queued.map((entry) =>
          entry.state === 'conflict' ? (
            <li key={entry.id}>
              <p>
                {`Enquanto você estava sem conexão, alguém mudou “${entry.itemTitle}”: ${conflictText(entry)}.`}
              </p>
              <div className="actions">
                <Button
                  variant="quiet"
                  busy={decide.busy}
                  onClick={() => {
                    decide.run(entry.id, true);
                  }}
                >
                  Manter a minha
                </Button>
                <Button
                  variant="quiet"
                  busy={decide.busy}
                  onClick={() => {
                    decide.run(entry.id, false);
                  }}
                >
                  Ficar com a de lá
                </Button>
              </div>
            </li>
          ) : entry.state === 'refused' ? (
            <li key={entry.id}>
              <p>{`A mudança em “${entry.itemTitle}” não foi aceita: ${entry.reason ?? ''}`}</p>
              <div className="actions">
                <Button
                  variant="quiet"
                  busy={decide.busy}
                  onClick={() => {
                    decide.run(entry.id, false);
                  }}
                >
                  Entendi
                </Button>
              </div>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
