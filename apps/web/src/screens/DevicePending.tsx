import { useEffect, useState, type ReactNode } from 'react';
import { api, type DeviceStatus } from '../api.js';
import { AuthLayout, SIGN_IN_GATES } from '../ui/AuthLayout.js';
import { Button, Notice } from '../ui/kit.js';

const POLL_MS = 5000;

/** Both factors are proven, but this browser is new: someone with authority has to let it in. */
export function DevicePending({
  instanceName,
  onSignIn,
}: {
  instanceName: string;
  onSignIn: (notice?: string) => void;
}): ReactNode {
  const [status, setStatus] = useState<DeviceStatus>('pending');

  useEffect(() => {
    if (status !== 'pending') return undefined;
    const timer = window.setInterval(() => {
      api.deviceStatus().then(
        (result) => {
          setStatus(result.status);
        },
        () => undefined, // offline for a moment: keep waiting
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [status]);

  if (status === 'approved') {
    return (
      <AuthLayout
        instanceName={instanceName}
        title="Dispositivo aprovado"
        gates={SIGN_IN_GATES}
        current={3}
      >
        <Notice tone="ok">
          Este aparelho foi aprovado. Entre mais uma vez para começar a usar.
        </Notice>
        <Button
          onClick={() => {
            onSignIn();
          }}
        >
          Entrar
        </Button>
      </AuthLayout>
    );
  }
  if (status === 'pending') {
    return (
      <AuthLayout
        instanceName={instanceName}
        title="Aguardando aprovação deste aparelho"
        gates={SIGN_IN_GATES}
        current={2}
      >
        <p className="lead">
          Sua senha e seu código estão certos. Como é a primeira vez neste aparelho, um Dono ou ADM
          precisa aprová-lo. Avise quem administra o sistema.
        </p>
        <p className="waiting" role="status">
          Esta página avança sozinha quando a aprovação chegar. Pode deixá-la aberta.
        </p>
        <Button
          variant="quiet"
          onClick={() => {
            onSignIn();
          }}
        >
          Entrar com outra conta
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      instanceName={instanceName}
      title="Este aparelho não foi aprovado"
      gates={SIGN_IN_GATES}
      current={2}
    >
      <Notice tone="error">
        O pedido de acesso deste aparelho foi recusado ou cancelado. Se foi engano, fale com quem
        administra o sistema e entre de novo para pedir outra vez.
      </Notice>
      <Button
        onClick={() => {
          onSignIn();
        }}
      >
        Voltar para a entrada
      </Button>
    </AuthLayout>
  );
}
