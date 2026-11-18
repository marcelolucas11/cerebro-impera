import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, type ReactNode } from 'react';
import { api, type Device, type Me } from '../api.js';
import { describeDevice, formatWhen, lastUsed } from '../labels.js';
import { describeError, ROLE_NAMES } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, useAction } from '../ui/kit.js';

/** Every browser that asked to get in: the ones waiting, and the ones already trusted. */
export function Devices({ me }: { me: Me['user'] }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  // Someone may be standing at the door right now: keep the list fresh.
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    refetchInterval: 10_000,
  });
  const decide = useAction(
    useCallback(
      async (id: string, decision: 'approve' | 'reject' | 'revoke') => {
        await guard(() => api.decideDevice(id, decision));
        await queryClient.invalidateQueries({ queryKey: ['devices'] });
      },
      [guard, queryClient],
    ),
  );

  if (devices.isPending) return <p className="lead">Abrindo…</p>;
  if (devices.isError) return <Notice tone="error">{describeError(devices.error)}</Notice>;
  const waiting = devices.data.filter(
    (device) => device.status === 'pending' && device.userId !== me.id,
  );
  const trusted = devices.data.filter((device) => device.status === 'approved');

  const owner = (device: Device): ReactNode => (
    <>
      {device.userName}
      {device.userId === me.id ? (
        <span className="tag">você</span>
      ) : (
        <span className="muted"> {ROLE_NAMES[device.userRole]}</span>
      )}
    </>
  );

  return (
    <>
      <h1>Aparelhos</h1>
      {decide.error ? <Notice tone="error">{decide.error}</Notice> : null}
      <section className="space">
        <h2>Aguardando aprovação</h2>
        {waiting.length === 0 ? (
          <p className="field-note">Nenhum aparelho esperando.</p>
        ) : (
          <>
            <p className="lead">
              Só aprove se você sabe que foi a própria pessoa que acabou de tentar entrar. Na
              dúvida, confirme com ela por outro meio antes.
            </p>
            <ul className="rows">
              {waiting.map((device) => (
                <li key={device.id}>
                  <span>
                    {owner(device)}
                    <span className="row-detail">
                      {describeDevice(device.userAgent)}, pedido em {formatWhen(device.createdAt)}
                      {device.createdIp ? `, do endereço ${device.createdIp}` : ''}
                    </span>
                  </span>
                  <span className="actions">
                    <Button
                      busy={decide.busy}
                      onClick={() => {
                        decide.run(device.id, 'approve');
                      }}
                    >
                      Aprovar
                    </Button>
                    <Button
                      variant="quiet"
                      busy={decide.busy}
                      onClick={() => {
                        decide.run(device.id, 'reject');
                      }}
                    >
                      Recusar
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="space">
        <h2>Aprovados</h2>
        <ul className="rows">
          {trusted.map((device) => (
            <li key={device.id}>
              <span>
                {owner(device)}
                <span className="row-detail">
                  {describeDevice(device.userAgent)}, {lastUsed(device.lastSeenAt)}
                </span>
              </span>
              <Button
                variant="quiet"
                busy={decide.busy}
                onClick={() => {
                  decide.run(device.id, 'revoke');
                }}
              >
                Revogar
              </Button>
            </li>
          ))}
        </ul>
        <p className="field-note">
          Revogar encerra na hora as sessões daquele aparelho e, no próximo contato dele com o
          servidor, apaga o que ele guardou para ler sem conexão. Para voltar a usá-lo, a pessoa
          precisa entrar e ser aprovada de novo.
        </p>
      </section>
    </>
  );
}
