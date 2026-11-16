import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Enrollment, type SignInResult } from '../api.js';
import { describeError } from '../messages.js';
import { Authenticator } from '../ui/Authenticator.js';
import { AuthLayout, SIGN_IN_GATES } from '../ui/AuthLayout.js';
import { Button, Form, Notice, useAction } from '../ui/kit.js';
import { PasswordField, passwordIsAcceptable } from '../ui/PasswordField.js';
import { RecoveryCodes } from '../ui/RecoveryCodes.js';

/** First sign-in after an invite or an access reset: link an authenticator, then keep the codes. */
export function Enroll({
  instanceName,
  onResult,
  onRestart,
}: {
  instanceName: string;
  onResult: (result: SignInResult) => void;
  onRestart: () => void;
}): ReactNode {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<(SignInResult & { recoveryCodes: string[] }) | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    // Asking twice would replace the key the person is about to scan.
    if (requested.current) return;
    requested.current = true;
    api.enrollStart().then(setEnrollment, (failure: unknown) => {
      setLoadError(describeError(failure));
    });
  }, []);

  const confirm = useAction(
    useCallback(async (code: string) => {
      setDone(await api.enrollConfirm(code));
    }, []),
  );

  if (done) {
    return (
      <AuthLayout
        instanceName={instanceName}
        title="Guarde seus códigos de recuperação"
        gates={SIGN_IN_GATES}
        current={1}
      >
        <RecoveryCodes
          codes={done.recoveryCodes}
          onDone={() => {
            onResult({ status: done.status });
          }}
        />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      instanceName={instanceName}
      title="Ligue seu autenticador"
      gates={SIGN_IN_GATES}
      current={1}
    >
      {loadError ? (
        <>
          <Notice tone="error">{loadError}</Notice>
          <Button onClick={onRestart}>Entrar de novo</Button>
        </>
      ) : enrollment ? (
        <Authenticator
          enrollment={enrollment}
          onConfirm={confirm.run}
          busy={confirm.busy}
          error={confirm.error}
        />
      ) : (
        <p className="lead" role="status">
          Preparando sua chave…
        </p>
      )}
    </AuthLayout>
  );
}

/** Someone invited this person (or reset their access): they choose their own password here. */
export function Invite({
  instanceName,
  token,
  onAccepted,
}: {
  instanceName: string;
  token: string;
  onAccepted: () => void;
}): ReactNode {
  const [password, setPassword] = useState('');
  const accept = useAction(
    useCallback(async () => {
      await api.acceptInvite({ token, password });
      onAccepted();
    }, [token, password, onAccepted]),
  );
  return (
    <AuthLayout
      instanceName={instanceName}
      title="Crie seu acesso"
      gates={SIGN_IN_GATES}
      current={0}
    >
      <p className="lead">
        Você foi convidado. A senha é escolhida por você e ninguém mais a vê, nem quem administra o
        sistema.
      </p>
      <Form onSubmit={accept.run}>
        <PasswordField value={password} onChange={setPassword} identity={{}} />
        {accept.error ? <Notice tone="error">{accept.error}</Notice> : null}
        <Button type="submit" busy={accept.busy} disabled={!passwordIsAcceptable(password, {})}>
          Continuar para o autenticador
        </Button>
      </Form>
    </AuthLayout>
  );
}
