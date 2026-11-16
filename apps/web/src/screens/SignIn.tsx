import { useCallback, useState, type ReactNode } from 'react';
import { api, type SignInResult } from '../api.js';
import { CodeField } from '../ui/Authenticator.js';
import { AuthLayout, SIGN_IN_GATES } from '../ui/AuthLayout.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';

export function SignIn({
  instanceName,
  notice,
  onPassword,
}: {
  instanceName: string;
  notice?: string | undefined;
  onPassword: (next: 'totp' | 'enroll_totp') => void;
}): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = useAction(
    useCallback(async () => {
      const { next } = await api.signIn({ email, password });
      onPassword(next);
    }, [email, password, onPassword]),
  );
  return (
    <AuthLayout instanceName={instanceName} title="Entrar" gates={SIGN_IN_GATES} current={0}>
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      <Form onSubmit={submit.run}>
        <Field
          label="E-mail"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          autoComplete="username"
          autoFocus
          required
        />
        <Field
          label="Senha"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          autoComplete="current-password"
          required
        />
        {submit.error ? <Notice tone="error">{submit.error}</Notice> : null}
        <Button type="submit" busy={submit.busy} disabled={email === '' || password === ''}>
          Continuar
        </Button>
      </Form>
      <p className="field-note">
        Esqueceu a senha? Só um Dono ou ADM pode liberar um novo acesso para você.
      </p>
    </AuthLayout>
  );
}

export function SecondFactor({
  instanceName,
  onResult,
  onRestart,
}: {
  instanceName: string;
  onResult: (result: SignInResult) => void;
  onRestart: () => void;
}): ReactNode {
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const submit = useAction(
    useCallback(async () => {
      onResult(
        await api.verify(mode === 'code' ? { code } : { recoveryCode: recoveryCode.trim() }),
      );
    }, [mode, code, recoveryCode, onResult]),
  );
  return (
    <AuthLayout
      instanceName={instanceName}
      title="Confirme que é você"
      gates={SIGN_IN_GATES}
      current={1}
    >
      <Form onSubmit={submit.run}>
        {mode === 'code' ? (
          <CodeField
            value={code}
            onChange={setCode}
            label="Código de 6 dígitos do aplicativo autenticador"
          />
        ) : (
          <Field
            label="Código de recuperação"
            hint="Cada código funciona uma única vez, e os Donos são avisados quando um é usado."
            value={recoveryCode}
            onChange={(event) => {
              setRecoveryCode(event.target.value);
            }}
            className="exact-input"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
          />
        )}
        {submit.error ? <Notice tone="error">{submit.error}</Notice> : null}
        <Button
          type="submit"
          busy={submit.busy}
          disabled={mode === 'code' ? code.length !== 6 : recoveryCode.trim().length < 8}
        >
          Entrar
        </Button>
      </Form>
      <div className="actions">
        <Button
          variant="quiet"
          onClick={() => {
            setMode(mode === 'code' ? 'recovery' : 'code');
          }}
        >
          {mode === 'code' ? 'Estou sem o celular' : 'Usar o aplicativo autenticador'}
        </Button>
        <Button variant="quiet" onClick={onRestart}>
          Entrar com outra conta
        </Button>
      </div>
    </AuthLayout>
  );
}
