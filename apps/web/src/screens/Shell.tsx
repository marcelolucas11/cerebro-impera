import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, type ReactNode } from 'react';
import { api } from '../api.js';
import { describeError, ROLE_NAMES } from '../messages.js';
import { useLiveUpdates } from '../live.js';
import { Link, listIdFrom, listViewFrom, usePath } from '../router.js';
import { onSignedOut as listenForSignOut } from '../session.js';
import { StepUpProvider } from '../stepup.js';
import { Button, Notice, useAction } from '../ui/kit.js';
import { Devices } from './Devices.js';
import { Home } from './Home.js';
import { Account } from './Account.js';
import { ListScreen } from './ListScreen.js';
import { Notifications, useUnreadNotifications } from './Notifications.js';
import { People } from './People.js';
import { Search, SearchBox } from './Search.js';
import { Security } from './Security.js';
import { Spaces } from './Spaces.js';

/** The frame around every screen a signed-in person sees. */
export function Shell({ onSignedOut }: { onSignedOut: (notice?: string) => void }): ReactNode {
  const queryClient = useQueryClient();
  const path = usePath();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const unread = useUnreadNotifications();
  useLiveUpdates();

  useEffect(
    () =>
      listenForSignOut(() => {
        queryClient.clear();
        onSignedOut('Sua sessão terminou. Entre de novo.');
      }),
    [onSignedOut, queryClient],
  );

  const signOut = useAction(
    useCallback(async () => {
      await api.signOut();
      queryClient.clear();
      onSignedOut();
    }, [onSignedOut, queryClient]),
  );

  if (me.isPending) return <p className="boot">Abrindo…</p>;
  if (me.isError) {
    return (
      <div className="boot">
        <Notice tone="error">{describeError(me.error)}</Notice>
        <Button
          onClick={() => {
            void me.refetch();
          }}
        >
          Tentar de novo
        </Button>
      </div>
    );
  }

  const { user, capabilities, instanceName } = me.data;
  const isOwner = user.role === 'owner';
  const can = (capability: string): boolean => isOwner || capabilities.includes(capability);
  const sections = [
    { to: '/inicio', label: 'Início', show: true },
    { to: '/', label: 'Espaços', show: true },
    { to: '/pessoas', label: 'Pessoas', show: can('users.manage') },
    { to: '/aparelhos', label: 'Aparelhos', show: true },
    { to: '/seguranca', label: 'Segurança', show: can('audit.view') },
  ].filter((section) => section.show);
  const listId = listIdFrom(path);
  const here = sections.find((section) => section.to === path);

  return (
    <StepUpProvider>
      <div className="shell">
        <header className="shell-bar">
          <p className="shell-brand">{instanceName}</p>
          <nav className="shell-nav" aria-label="Seções">
            {sections.map((section) => (
              <Link
                key={section.to}
                to={section.to}
                current={section.to === path || (section.to === '/' && listId !== undefined)}
              >
                {section.label}
              </Link>
            ))}
          </nav>
          <SearchBox />
          <Link to="/avisos" current={path === '/avisos'}>
            <span className="shell-notices">
              Avisos
              {unread > 0 ? (
                <span className="notice-count">
                  {unread > 99 ? '99+' : unread}
                  <span className="visually-hidden">
                    {unread === 1 ? ' não lido' : ' não lidos'}
                  </span>
                </span>
              ) : null}
            </span>
          </Link>
          <div className="shell-person">
            <p>
              <Link to="/conta" current={path === '/conta'}>
                {user.name}
              </Link>
              <span className="shell-role">{ROLE_NAMES[user.role]}</span>
            </p>
            <Button variant="quiet" onClick={signOut.run} busy={signOut.busy}>
              Sair
            </Button>
          </div>
        </header>
        <main className={listId !== undefined ? 'shell-main shell-main-wide' : 'shell-main'}>
          {signOut.error ? <Notice tone="error">{signOut.error}</Notice> : null}
          {listId !== undefined ? (
            <ListScreen
              key={listId}
              listId={listId}
              view={listViewFrom(path)}
              me={user}
              canSeePeople={can('users.manage')}
            />
          ) : path === '/conta' ? (
            <Account me={user} />
          ) : path === '/busca' ? (
            <Search />
          ) : path === '/avisos' ? (
            <Notifications />
          ) : path === '/inicio' ? (
            <Home name={user.name} />
          ) : here === undefined ? (
            <>
              <h1>Esta página não existe</h1>
              <p className="lead">
                O endereço pode estar errado, ou você não tem acesso a esta seção.
              </p>
              <Link to="/" current={false}>
                Ir para Espaços
              </Link>
            </>
          ) : path === '/pessoas' ? (
            <People me={user} />
          ) : path === '/aparelhos' ? (
            <Devices me={user} />
          ) : path === '/seguranca' ? (
            <Security isOwner={isOwner} canSeePeople={can('users.manage')} />
          ) : (
            <Spaces isOwner={isOwner} />
          )}
        </main>
      </div>
    </StepUpProvider>
  );
}
