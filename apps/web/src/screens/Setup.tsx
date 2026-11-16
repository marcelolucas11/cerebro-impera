import { useCallback, useState, type ReactNode } from 'react';
import { api, type Enrollment } from '../api.js';
import { Authenticator } from '../ui/Authenticator.js';
import { AuthLayout } from '../ui/AuthLayout.js';
import type { Gate } from '../ui/Gates.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';
import { PasswordField, passwordIsAcceptable } from '../ui/PasswordField.js';
import { RecoveryCodes } from '../ui/RecoveryCodes.js';

const GATES: readonly Gate[] = [
  { label: 'Sua conta de Dono', detail: 'Quem instala é o primeiro Dono.' },
  { label: 'Autenticador', detail: 'O segundo fator é obrigatório para todos.' },
  { label: 'Códigos de recuperação', detail: 'Para o dia em que o celular faltar.' },
];

/** First run: whoever holds the token from the server creates the first owner. Runs once, ever. */
export function Setup({ onDone }: { onDone: () => void }): ReactNode {
  const [form, setForm] = useState({
    setupToken: '',
    instanceName: '',
    name: '',
    email: '',
    password: '',
  });
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const start = useAction(
    useCallback(async () => {
      setEnrollment(await api.setupTotp({ setupToken: form.setupToken.trim(), email: form.email }));
    }, [form.setupToken, form.email]),
  );
  const finish = useAction(
    useCallback(
      async (totpCode: string) => {
        if (!enrollment) return;
        const result = await api.completeSetup({
          ...form,
          setupToken: form.setupToken.trim(),
          totpSecret: enrollment.secret,
          totpCode,
        });
        setCodes(result.recoveryCodes);
      },
      [enrollment, form],
    ),
  );

  const ready =
    form.setupToken.trim() !== '' &&
    form.instanceName.trim() !== '' &&
    form.name.trim() !== '' &&
    form.email.includes('@') &&
    passwordIsAcceptable(form.password, form);

  if (codes) {
    return (
      <AuthLayout
        instanceName={form.instanceName}
        title="Guarde seus códigos de recuperação"
        gates={GATES}
        current={2}
      >
        <RecoveryCodes codes={codes} onDone={onDone} />
      </AuthLayout>
    );
  }
  if (enrollment) {
    return (
      <AuthLayout
        instanceName={form.instanceName}
        title="Ligue seu autenticador"
        gates={GATES}
        current={1}
      >
        <Authenticator
          enrollment={enrollment}
          onConfirm={finish.run}
          busy={finish.busy}
          error={finish.error}
        />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout instanceName="Cérebro" title="Instalar" gates={GATES} current={0}>
      <p className="lead">
        Esta instalação ainda não tem dono. Para criá-lo é preciso o token que o servidor gravou no
        arquivo <code>setup-token</code>: só quem tem acesso ao servidor consegue lê-lo.
      </p>
      <Form onSubmit={start.run}>
        <Field
          label="Token de instalação"
          value={form.setupToken}
          onChange={(event) => {
            set('setupToken')(event.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
          className="exact-input"
          autoFocus
          required
        />
        <Field
          label="Nome da empresa"
          hint="Aparece no topo do sistema e no aplicativo autenticador de cada pessoa."
          value={form.instanceName}
          onChange={(event) => {
            set('instanceName')(event.target.value);
          }}
          autoComplete="organization"
          maxLength={80}
          required
        />
        <Field
          label="Seu nome"
          value={form.name}
          onChange={(event) => {
            set('name')(event.target.value);
          }}
          autoComplete="name"
          maxLength={120}
          required
        />
        <Field
          label="Seu e-mail"
          type="email"
          value={form.email}
          onChange={(event) => {
            set('email')(event.target.value);
          }}
          autoComplete="username"
          required
        />
        <PasswordField value={form.password} onChange={set('password')} identity={form} />
        {start.error ? <Notice tone="error">{start.error}</Notice> : null}
        <Button type="submit" busy={start.busy} disabled={!ready}>
          Continuar para o autenticador
        </Button>
      </Form>
    </AuthLayout>
  );
}
