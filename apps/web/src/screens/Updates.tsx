import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import { api, type UpdatesView } from '../api.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { refusalText, STEP_NAMES, STEP_ORDER, stepState } from '../updates.js';
import { Button, Notice, useAction } from '../ui/kit.js';

/*
 * Updates, for owners: the version in use, a newer one when there is one, and
 * an update going step by step. Only versions published and signed by the
 * project's own release flow are installed; the database is copied first, and
 * the previous version comes back by itself if the new one does not start well.
 */
export function Updates(): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: api.updates,
    refetchInterval: (query) => (query.state.data?.job?.state === 'running' ? 2_000 : false),
  });
  const keep = useCallback(
    (view: UpdatesView) => {
      queryClient.setQueryData(['updates'], view);
    },
    [queryClient],
  );
  const check = useAction(
    useCallback(async () => {
      keep(await api.checkUpdates());
    }, [keep]),
  );
  const apply = useAction(
    useCallback(
      async (version: string) => {
        keep(await guard(() => api.applyUpdate(version)));
      },
      [guard, keep],
    ),
  );

  if (updates.isPending) return <p className="lead">Abrindo…</p>;
  if (updates.isError) return <Notice tone="error">{describeError(updates.error)}</Notice>;
  const view = updates.data;
  const job = view.job;
  const running = job?.state === 'running';

  return (
    <div className="updates">
      <h1>Atualizações</h1>
      <p className="lead">
        {`Versão em uso: ${view.current}. Só entra uma versão publicada e assinada pelo repositório do projeto. Antes de trocar, o banco de dados é copiado; se a versão nova não subir bem, a anterior volta sozinha.`}
      </p>

      {!view.configured ? (
        <Notice tone="info">
          Esta instalação não tem o atualizador ligado. Quem cuida do servidor liga o serviço
          "updater" (veja infra/README.md); depois disso, as atualizações aparecem aqui.
        </Notice>
      ) : !view.reachable ? (
        <Notice tone="info">
          O atualizador não respondeu agora. Durante uma atualização isso é esperado por alguns
          segundos; se continuar, tente de novo em alguns minutos.
        </Notice>
      ) : null}
      {view.refused !== null ? <Notice tone="error">{refusalText(view.refused)}</Notice> : null}
      {check.error ? <Notice tone="error">{check.error}</Notice> : null}
      {apply.error ? <Notice tone="error">{apply.error}</Notice> : null}

      {job !== null ? (
        <section className="update-job" aria-label="Andamento da atualização">
          <h2>
            {job.state === 'running'
              ? `Atualizando para ${job.to}`
              : job.state === 'applied'
                ? `Atualizado para ${job.to}`
                : `A versão ${job.to} não ficou`}
          </h2>
          {job.state === 'running' ? (
            <ol className="update-steps">
              {STEP_ORDER.map((step) => (
                <li key={step} className={`is-${stepState(step, job.step)}`}>
                  {STEP_NAMES[step]}
                  {stepState(step, job.step) === 'done' ? (
                    <span className="visually-hidden"> (feito)</span>
                  ) : stepState(step, job.step) === 'now' ? (
                    <span className="visually-hidden"> (agora)</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : job.state === 'applied' ? (
            <p className="muted">
              {`Concluída em ${formatWhen(job.finishedAt ?? job.startedAt)}, a partir da ${job.from}.`}
            </p>
          ) : (
            <p>
              {`A versão ${job.to} não subiu bem, e a ${job.from} voltou, com o banco de dados como estava.${job.problem === null ? '' : ` ${job.problem}`}`}
            </p>
          )}
        </section>
      ) : null}

      {view.configured && !running ? (
        <section className="update-check" aria-label="Procurar atualização">
          {view.available !== null ? (
            <article className="update-available">
              <h2>{`Versão ${view.available.version} disponível`}</h2>
              <p className="muted">{`Publicada em ${formatWhen(view.available.publishedAt)}.`}</p>
              <pre className="update-notes">{view.available.notes}</pre>
              <Button
                busy={apply.busy}
                onClick={() => {
                  if (view.available !== null) apply.run(view.available.version);
                }}
              >
                Atualizar agora
              </Button>
            </article>
          ) : view.checkedAt !== null ? (
            <p>{`Nenhuma versão nova. Última procura em ${formatWhen(view.checkedAt)}.`}</p>
          ) : null}
          <Button variant="quiet" busy={check.busy} onClick={check.run}>
            Procurar atualização
          </Button>
        </section>
      ) : null}
    </div>
  );
}
