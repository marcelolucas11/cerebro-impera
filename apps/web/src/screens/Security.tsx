import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type AuditEntry } from '../api.js';
import { actionName, ALERT_NAMES, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { Button, Notice, useAction } from '../ui/kit.js';

/** What happened, who did it, and whether the record itself is still intact. */
export function Security({
  isOwner,
  canSeePeople,
}: {
  isOwner: boolean;
  canSeePeople: boolean;
}): ReactNode {
  const people = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: canSeePeople });
  const names = new Map((people.data ?? []).map((user) => [user.id, user.name]));
  const nameOf = (id: string | null): string =>
    id === null ? 'Sistema' : (names.get(id) ?? 'Pessoa fora do seu alcance');
  return (
    <>
      <h1>Segurança</h1>
      {isOwner ? <Alerts nameOf={nameOf} /> : null}
      <Trail nameOf={nameOf} />
    </>
  );
}

function Alerts({ nameOf }: { nameOf: (id: string | null) => string }): ReactNode {
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, refetchInterval: 30_000 });
  const seen = useAction(
    useCallback(
      async (id: string) => {
        await api.acknowledgeAlert(id);
        await queryClient.invalidateQueries({ queryKey: ['alerts'] });
      },
      [queryClient],
    ),
  );
  const open = (alerts.data ?? []).filter((alert) => alert.acknowledgedAt === null);
  return (
    <section className="space">
      <h2>Alertas</h2>
      {alerts.isError ? <Notice tone="error">{describeError(alerts.error)}</Notice> : null}
      {seen.error ? <Notice tone="error">{seen.error}</Notice> : null}
      {alerts.isSuccess && open.length === 0 ? (
        <p className="field-note">Nenhum alerta em aberto.</p>
      ) : null}
      <ul className="rows">
        {open.map((alert) => (
          <li key={alert.id}>
            <span>
              <span className={`state state-${alert.severity}`}>
                {ALERT_NAMES[alert.kind] ?? alert.kind}
              </span>
              <span className="row-detail">
                {formatWhen(alert.at)}, por {nameOf(alert.actorUserId)}
              </span>
            </span>
            <Button
              variant="quiet"
              busy={seen.busy}
              onClick={() => {
                seen.run(alert.id);
              }}
            >
              Marcar como visto
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Trail({ nameOf }: { nameOf: (id: string | null) => string }): ReactNode {
  const first = useQuery({ queryKey: ['audit'], queryFn: () => api.audit() });
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [integrity, setIntegrity] = useState<{
    ok: boolean;
    checked: number;
    brokenSeq: number | null;
  } | null>(null);
  const entries = [...(first.data ?? []), ...older];
  const last = entries.at(-1);

  const more = useAction(
    useCallback(async () => {
      if (!last) return;
      const page = await api.audit(last.seq);
      setOlder((current) => [...current, ...page]);
    }, [last]),
  );
  const verify = useAction(
    useCallback(async () => {
      setIntegrity(await api.verifyAudit());
    }, []),
  );

  return (
    <section className="space">
      <h2>Registro de auditoria</h2>
      <p className="lead">
        Tudo o que muda acessos ou entra no sistema fica registrado aqui. Ninguém consegue editar ou
        apagar uma linha, nem os Donos.
      </p>
      <div className="actions">
        <Button variant="quiet" busy={verify.busy} onClick={verify.run}>
          Verificar se o registro está íntegro
        </Button>
      </div>
      {verify.error ? <Notice tone="error">{verify.error}</Notice> : null}
      {integrity ? (
        integrity.ok ? (
          <Notice tone="ok">
            Registro íntegro: {integrity.checked} entradas conferidas, nenhuma alterada ou removida.
          </Notice>
        ) : (
          <Notice tone="error">
            O registro foi adulterado a partir da entrada {integrity.brokenSeq}. Alguém com acesso
            direto ao banco de dados alterou ou removeu linhas. Trate como incidente de segurança.
          </Notice>
        )
      ) : null}
      {first.isError ? <Notice tone="error">{describeError(first.error)}</Notice> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Quando</th>
              <th scope="col">Quem</th>
              <th scope="col">O quê</th>
              <th scope="col">De onde</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.seq}>
                <td>{formatWhen(entry.at)}</td>
                <td>{nameOf(entry.actorUserId)}</td>
                <td>{actionName(entry.action)}</td>
                <td className="muted">{entry.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more.error ? <Notice tone="error">{more.error}</Notice> : null}
      {last && last.seq > 1 ? (
        <Button variant="quiet" busy={more.busy} onClick={more.run}>
          Carregar entradas mais antigas
        </Button>
      ) : null}
    </section>
  );
}
