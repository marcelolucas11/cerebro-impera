import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, type ReactNode } from 'react';
import { api, ApiError, type Tree } from '../api.js';
import { describeError, ROLE_NAMES } from '../messages.js';
import { Button, Notice, useAction } from '../ui/kit.js';

const LEVELS: Record<Tree['lists'][number]['level'], string> = {
  view: 'Pode ver',
  comment: 'Pode comentar',
  edit: 'Pode editar',
  manage: 'Gerencia',
};

const signedOut = (error: unknown): boolean => error instanceof ApiError && error.status === 401;

/**
 * What a signed-in person lands on. For now it lists the areas they can reach;
 * statuses, views and tasks arrive with the next phases.
 */
export function Home({ onSignedOut }: { onSignedOut: (notice?: string) => void }): ReactNode {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const tree = useQuery({
    queryKey: ['tree'],
    queryFn: api.tree,
    retry: false,
    enabled: me.isSuccess,
  });

  const expired = signedOut(me.error) || signedOut(tree.error);
  useEffect(() => {
    if (expired) {
      queryClient.clear();
      onSignedOut('Sua sessão terminou. Entre de novo.');
    }
  }, [expired, onSignedOut, queryClient]);

  const signOut = useAction(
    useCallback(async () => {
      await api.signOut();
      queryClient.clear();
      onSignedOut();
    }, [onSignedOut, queryClient]),
  );

  if (me.isPending || expired) return <p className="boot">Abrindo…</p>;
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

  const { user, instanceName } = me.data;
  return (
    <div className="shell">
      <header className="shell-bar">
        <p className="shell-brand">{instanceName}</p>
        <div className="shell-person">
          <p>
            {user.name}
            <span className="shell-role">{ROLE_NAMES[user.role]}</span>
          </p>
          <Button variant="quiet" onClick={signOut.run} busy={signOut.busy}>
            Sair
          </Button>
        </div>
      </header>
      <main className="shell-main">
        <h1>Seus espaços</h1>
        {signOut.error ? <Notice tone="error">{signOut.error}</Notice> : null}
        {tree.isError ? <Notice tone="error">{describeError(tree.error)}</Notice> : null}
        {tree.isSuccess ? <Spaces tree={tree.data} isOwner={user.role === 'owner'} /> : null}
      </main>
    </div>
  );
}

function Spaces({ tree, isOwner }: { tree: Tree; isOwner: boolean }): ReactNode {
  if (tree.spaces.length === 0) {
    return (
      <p className="lead">
        {isOwner
          ? 'Ainda não existe nenhum espaço. A tela para criar espaços, pastas e listas chega na próxima etapa da construção.'
          : 'Você ainda não tem acesso a nenhuma lista. Peça a um Dono ou ADM para liberar as áreas em que você trabalha.'}
      </p>
    );
  }
  return (
    <>
      {tree.spaces.map((space) => (
        <section key={space.id} className="space">
          <h2>{space.name}</h2>
          <Lists lists={tree.lists.filter((l) => l.spaceId === space.id && l.folderId === null)} />
          {tree.folders
            .filter((folder) => folder.spaceId === space.id)
            .map((folder) => (
              <div key={folder.id} className="folder">
                <h3>{folder.name}</h3>
                <Lists lists={tree.lists.filter((l) => l.folderId === folder.id)} />
              </div>
            ))}
        </section>
      ))}
    </>
  );
}

function Lists({ lists }: { lists: Tree['lists'] }): ReactNode {
  if (lists.length === 0) return null;
  return (
    <ul className="lists">
      {lists.map((list) => (
        <li key={list.id}>
          <span className="list-name">
            {list.name}
            {list.isSensitive ? <span className="list-sensitive">sensível</span> : null}
          </span>
          <span className="list-access">
            {LEVELS[list.level]}
            {list.itemScope === 'assigned' ? ', só os seus itens' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
