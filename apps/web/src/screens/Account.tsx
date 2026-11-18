import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type Me, type MySession } from '../api.js';
import { describeDevice, formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import { CodeField } from '../ui/Authenticator.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';
import { PasswordField, passwordIsAcceptable } from '../ui/PasswordField.js';

/** What a person manages about their own access: the password and where they are signed in. */
export function Account({ me }: { me: Me['user'] }): ReactNode {
  return (
    <>
      <h1>Minha conta</h1>
      <p className="lead">Você entra como {me.email}.</p>
      <ChangePassword me={me} />
      <MySessions />
    </>
  );
}

function ChangePassword({ me }: { me: Me['user'] }): ReactNode {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const change = useAction(
    useCallback(async () => {
      setDone(null);
      const { endedSessions } = await api.changePassword({
        currentPassword: current,
        newPassword: next,
        code,
      });
      setCurrent('');
      setNext('');
      setCode('');
      setDone(
        endedSessions === 0
          ? 'Senha trocada.'
          : endedSessions === 1
            ? 'Senha trocada. A outra sessão aberta com sua conta foi encerrada.'
            : `Senha trocada. As outras ${endedSessions} sessões abertas com sua conta foram encerradas.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    }, [current, next, code, queryClient]),
  );
  const ready =
    current !== '' &&
    passwordIsAcceptable(next, { email: me.email, name: me.name }) &&
    code.length === 6;
  return (
    <section className="panel" aria-label="Trocar a senha">
      <h2>Trocar a senha</h2>
      <p className="field-note">
        Ao trocar, todas as outras sessões abertas com sua conta são encerradas. Esta continua.
      </p>
      <Form onSubmit={change.run}>
        <Field
          label="Senha atual"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
          required
        />
        <PasswordField
          label="Nova senha"
          value={next}
          onChange={setNext}
          identity={{ email: me.email, name: me.name }}
        />
        <CodeField
          label="Código do aplicativo autenticador"
          value={code}
          onChange={setCode}
          autoFocus={false}
        />
        {change.error ? <Notice tone="error">{change.error}</Notice> : null}
        {done !== null ? <Notice tone="ok">{done}</Notice> : null}
        <Button type="submit" busy={change.busy} disabled={!ready}>
          Trocar senha
        </Button>
      </Form>
    </section>
  );
}

function MySessions(): ReactNode {
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: api.mySessions });
  return (
    <section className="panel" aria-label="Onde você está conectado">
      <h2>Onde você está conectado</h2>
      <p className="field-note">
        Cada linha é um navegador ou aplicativo com sua conta aberta. Se não reconhecer algum,
        encerre e troque a senha.
      </p>
      {sessions.isError ? <Notice tone="error">{describeError(sessions.error)}</Notice> : null}
      {sessions.isPending ? <p className="field-note">Abrindo…</p> : null}
      <ul className="rows">
        {(sessions.data ?? []).map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </ul>
    </section>
  );
}

function SessionRow({ session }: { session: MySession }): ReactNode {
  const queryClient = useQueryClient();
  const end = useAction(
    useCallback(async () => {
      await api.endSession(session.id);
      await queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    }, [session.id, queryClient]),
  );
  const device = describeDevice(session.userAgent);
  return (
    <li>
      <span>
        {device}
        {session.current ? <span className="tag">esta sessão</span> : null}
        <span className="row-detail">
          Aberta em {formatWhen(session.createdAt)}; último uso em {formatWhen(session.lastSeenAt)}
        </span>
      </span>
      {session.current ? null : (
        <Button variant="quiet" busy={end.busy} onClick={end.run}>
          Encerrar<span className="visually-hidden"> a sessão em {device}</span>
        </Button>
      )}
      {end.error ? <Notice tone="error">{end.error}</Notice> : null}
    </li>
  );
}
