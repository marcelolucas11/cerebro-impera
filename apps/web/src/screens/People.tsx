import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import {
  api,
  type AccessLevel,
  type InviteLink,
  type ItemScope,
  type Me,
  type Role,
  type ScopeType,
  type Tree,
  type User,
} from '../api.js';
import {
  CAPABILITY_NAMES,
  formatWhen,
  ITEM_SCOPE_NAMES,
  LEVEL_NAMES,
  STATUS_NAMES,
} from '../labels.js';
import { describeError, ROLE_NAMES } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, CopyButton, Exact, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };
const ALL_ROLES: readonly Role[] = ['employee', 'manager', 'admin', 'owner'];

/** Roles this person may hand out: owners any, everyone else only those below their own. */
function assignableRoles(me: Me['user']): Role[] {
  return ALL_ROLES.filter((role) => me.role === 'owner' || RANK[role] < RANK[me.role]);
}

/** Mirrors the server rule so the screen only offers what can work; the server still decides. */
function canManage(me: Me['user'], target: User): boolean {
  if (target.id === me.id) return false;
  return me.role === 'owner' || RANK[target.role] < RANK[me.role];
}

export function People({ me }: { me: Me['user'] }): ReactNode {
  // An invited person may accept at any moment: keep the list current while it is open.
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, refetchInterval: 15_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (users.isPending) return <p className="lead">Abrindo…</p>;
  if (users.isError) return <Notice tone="error">{describeError(users.error)}</Notice>;
  const selected = users.data.find((user) => user.id === selectedId);

  return (
    <>
      <h1>Pessoas</h1>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">E-mail</th>
              <th scope="col">Papel</th>
              <th scope="col">Situação</th>
              <th scope="col">
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => (
              <tr key={user.id} aria-selected={user.id === selectedId || undefined}>
                <th scope="row">
                  {user.name}
                  {user.id === me.id ? <span className="tag">você</span> : null}
                </th>
                <td>{user.email}</td>
                <td>{ROLE_NAMES[user.role]}</td>
                <td>
                  <span className={`state state-${user.status}`}>{STATUS_NAMES[user.status]}</span>
                </td>
                <td>
                  {canManage(me, user) ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setSelectedId(user.id === selectedId ? null : user.id);
                      }}
                    >
                      {user.id === selectedId ? 'Fechar' : 'Gerenciar'}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? <Person key={selected.id} me={me} user={selected} /> : <InvitePerson me={me} />}
    </>
  );
}

function AccessLink({ link }: { link: InviteLink }): ReactNode {
  const address = `${window.location.origin}/convite#${link.token}`;
  return (
    <div className="panel panel-brand">
      <p>
        {link.kind === 'invite' ? 'Convite criado.' : 'Novo acesso liberado.'} Envie este endereço
        direto para a pessoa, por um canal em que só ela leia. Ele funciona uma única vez e vale até{' '}
        {formatWhen(link.expiresAt)}.
      </p>
      <Exact>{address}</Exact>
      <CopyButton text={address} label="Copiar endereço" />
      <p className="field-note">
        Ele não será mostrado de novo. A pessoa escolhe a própria senha e liga o próprio
        autenticador.
      </p>
    </div>
  );
}

function InvitePerson({ me }: { me: Me['user'] }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const roles = assignableRoles(me);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [link, setLink] = useState<InviteLink | null>(null);
  const invite = useAction(
    useCallback(async () => {
      const created = await guard(() => api.createUser({ name, email, role }));
      setLink(created.invite);
      setName('');
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    }, [guard, name, email, role, queryClient]),
  );
  return (
    <section className="panel">
      <h2>Convidar pessoa</h2>
      {link ? <AccessLink link={link} /> : null}
      <Form onSubmit={invite.run}>
        <div className="inline-fields">
          <Field
            label="Nome"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            maxLength={120}
          />
          <Field
            label="E-mail"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <Select
            label="Papel"
            value={role}
            onChange={setRole}
            options={roles.map((value) => ({ value, label: ROLE_NAMES[value] }))}
          />
        </div>
        <p className="field-note">
          O papel define a posição na hierarquia. Ele sozinho não abre nenhum dado: depois de
          convidar, escolha em “Gerenciar” quais áreas a pessoa pode ver.
        </p>
        {invite.error ? <Notice tone="error">{invite.error}</Notice> : null}
        <Button
          type="submit"
          busy={invite.busy}
          disabled={name.trim() === '' || !email.includes('@')}
        >
          Convidar
        </Button>
      </Form>
    </section>
  );
}

function Person({ me, user }: { me: Me['user']; user: User }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const [link, setLink] = useState<InviteLink | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    [queryClient],
  );

  const change = useAction(
    useCallback(
      async (input: { role?: Role; status?: 'active' | 'suspended' }, message: string) => {
        await guard(() => api.updateUser(user.id, input));
        setDone(message);
        await refresh();
      },
      [guard, user.id, refresh],
    ),
  );
  const newLink = useAction(
    useCallback(async () => {
      setLink(await guard(() => api.newAccessLink(user.id)));
      await refresh();
    }, [guard, user.id, refresh]),
  );
  const endSessions = useAction(
    useCallback(async () => {
      await guard(() => api.revokeSessions(user.id));
      setDone('Sessões encerradas. A pessoa precisa entrar de novo em todos os aparelhos.');
    }, [guard, user.id]),
  );
  const error = change.error ?? newLink.error ?? endSessions.error;

  return (
    <section className="panel">
      <h2>{user.name}</h2>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : done ? (
        <Notice tone="ok">{done}</Notice>
      ) : null}
      {link ? <AccessLink link={link} /> : null}
      <div className="inline-fields">
        <Select
          label="Papel"
          value={user.role}
          disabled={change.busy}
          onChange={(role) => {
            change.run({ role }, `Papel alterado para ${ROLE_NAMES[role]}.`);
          }}
          options={[...new Set([...assignableRoles(me), user.role])].map((value) => ({
            value,
            label: ROLE_NAMES[value],
          }))}
        />
      </div>
      <div className="actions">
        {user.status === 'suspended' ? (
          <Button
            variant="quiet"
            busy={change.busy}
            onClick={() => {
              change.run({ status: 'active' }, 'Conta reativada.');
            }}
          >
            Reativar conta
          </Button>
        ) : (
          <Button
            variant="quiet"
            busy={change.busy}
            onClick={() => {
              change.run(
                { status: 'suspended' },
                'Conta suspensa. Todas as sessões foram encerradas.',
              );
            }}
          >
            {user.status === 'invited' ? 'Cancelar convite' : 'Suspender conta'}
          </Button>
        )}
        {user.status === 'suspended' ? null : (
          <Button variant="quiet" busy={newLink.busy} onClick={newLink.run}>
            {user.status === 'invited'
              ? 'Gerar novo convite'
              : 'Redefinir acesso (senha e autenticador)'}
          </Button>
        )}
        {user.status === 'active' ? (
          <Button variant="quiet" busy={endSessions.busy} onClick={endSessions.run}>
            Encerrar sessões
          </Button>
        ) : null}
      </div>
      {me.role === 'owner' && user.role !== 'owner' ? <Capabilities user={user} /> : null}
      <Grants user={user} />
    </section>
  );
}

function Capabilities({ user }: { user: User }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(user.capabilities));
  const [saved, setSaved] = useState(false);
  const save = useAction(
    useCallback(async () => {
      await guard(() => api.setCapabilities(user.id, [...chosen]));
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    }, [guard, user.id, chosen, queryClient]),
  );
  return (
    <div className="subsection">
      <h3>O que esta pessoa pode fazer além do próprio trabalho</h3>
      <ul className="checks">
        {Object.entries(CAPABILITY_NAMES).map(([key, text]) => (
          <li key={key}>
            <label className="check">
              <input
                type="checkbox"
                checked={chosen.has(key)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(key);
                  else next.delete(key);
                  setChosen(next);
                  setSaved(false);
                }}
              />
              <span>
                {text.name}
                <span className="check-detail">{text.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {save.error ? (
        <Notice tone="error">{save.error}</Notice>
      ) : saved ? (
        <Notice tone="ok">Capacidades salvas.</Notice>
      ) : null}
      <Button variant="quiet" busy={save.busy} onClick={save.run}>
        Salvar capacidades
      </Button>
    </div>
  );
}

function scopeOptions(tree: Tree): { value: string; label: string }[] {
  const spaceName = new Map(tree.spaces.map((space) => [space.id, space.name]));
  const folderName = new Map(tree.folders.map((folder) => [folder.id, folder.name]));
  const place = (spaceId: string, folderId: string | null): string =>
    [spaceName.get(spaceId), folderId === null ? undefined : folderName.get(folderId)]
      .filter((part) => part !== undefined)
      .join(' › ');
  return [
    ...tree.spaces.map((space) => ({
      value: `space:${space.id}`,
      label: `Espaço inteiro: ${space.name}`,
    })),
    ...tree.folders.map((folder) => ({
      value: `folder:${folder.id}`,
      label: `Pasta inteira: ${place(folder.spaceId, null)} › ${folder.name}`,
    })),
    ...tree.lists.map((list) => ({
      value: `list:${list.id}`,
      label: `Lista: ${place(list.spaceId, list.folderId)} › ${list.name}`,
    })),
  ];
}

function Grants({ user }: { user: User }): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  const grants = useQuery({
    queryKey: ['grants', user.id],
    queryFn: () => api.userGrants(user.id),
  });
  const options = tree.data ? scopeOptions(tree.data) : [];
  const [scope, setScope] = useState('');
  const [level, setLevel] = useState<AccessLevel>('edit');
  const [itemScope, setItemScope] = useState<ItemScope>(
    user.role === 'employee' ? 'assigned' : 'all',
  );
  const chosenScope = scope === '' ? options[0]?.value : scope;

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['grants', user.id] }),
    [queryClient, user.id],
  );
  const give = useAction(
    useCallback(async () => {
      if (chosenScope === undefined) return;
      const [scopeType, scopeId] = chosenScope.split(':') as [ScopeType, string];
      await guard(() => api.putGrant({ userId: user.id, scopeType, scopeId, level, itemScope }));
      await refresh();
    }, [guard, chosenScope, user.id, level, itemScope, refresh]),
  );
  const take = useAction(
    useCallback(
      async (id: string) => {
        await guard(() => api.deleteGrant(id));
        await refresh();
      },
      [guard, refresh],
    ),
  );
  const labelOf = (type: ScopeType, id: string): string =>
    options.find((option) => option.value === `${type}:${id}`)?.label ?? 'Área fora do seu alcance';

  return (
    <div className="subsection">
      <h3>Áreas que esta pessoa acessa</h3>
      {user.role === 'owner' ? (
        <p className="field-note">Donos veem tudo, sem precisar de concessão.</p>
      ) : (
        <>
          {grants.isError ? <Notice tone="error">{describeError(grants.error)}</Notice> : null}
          {grants.data?.length === 0 ? (
            <p className="field-note">
              Nenhuma área liberada ainda: esta pessoa entra e não vê nenhum dado.
            </p>
          ) : null}
          {grants.data && grants.data.length > 0 ? (
            <ul className="rows">
              {grants.data.map((grant) => (
                <li key={grant.id}>
                  <span>{labelOf(grant.scopeType, grant.scopeId)}</span>
                  <span className="muted">
                    {LEVEL_NAMES[grant.level]}
                    {grant.level === 'none'
                      ? ''
                      : `, ${ITEM_SCOPE_NAMES[grant.itemScope].toLowerCase()}`}
                  </span>
                  <Button
                    variant="quiet"
                    busy={take.busy}
                    onClick={() => {
                      take.run(grant.id);
                    }}
                  >
                    Retirar
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {options.length === 0 ? (
            <p className="field-note">Crie um espaço em “Espaços” para poder liberar áreas.</p>
          ) : (
            <Form onSubmit={give.run}>
              <div className="inline-fields">
                <Select
                  label="Área"
                  value={chosenScope ?? ''}
                  onChange={setScope}
                  options={options}
                />
                <Select
                  label="Nível"
                  value={level}
                  onChange={setLevel}
                  options={(['view', 'comment', 'edit', 'manage', 'none'] as const).map(
                    (value) => ({
                      value,
                      label:
                        value === 'none' ? 'Sem acesso (esconde esta área)' : LEVEL_NAMES[value],
                    }),
                  )}
                />
                <Select
                  label="Itens visíveis"
                  value={itemScope}
                  onChange={setItemScope}
                  options={(['assigned', 'all'] as const).map((value) => ({
                    value,
                    label: ITEM_SCOPE_NAMES[value],
                  }))}
                />
              </div>
              {(give.error ?? take.error) ? (
                <Notice tone="error">{give.error ?? take.error}</Notice>
              ) : null}
              <Button type="submit" busy={give.busy}>
                Liberar área
              </Button>
            </Form>
          )}
        </>
      )}
    </div>
  );
}
