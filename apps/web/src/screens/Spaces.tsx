import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type Tree } from '../api.js';
import { LEVEL_NAMES } from '../labels.js';
import { describeError } from '../messages.js';
import { Link } from '../router.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

/**
 * The areas this person can reach. Owners create spaces; whoever manages a
 * space or a folder creates folders and lists inside it.
 */
export function Spaces({ isOwner }: { isOwner: boolean }): ReactNode {
  const tree = useQuery({ queryKey: ['tree'], queryFn: api.tree });
  if (tree.isPending) return <p className="lead">Abrindo…</p>;
  if (tree.isError) return <Notice tone="error">{describeError(tree.error)}</Notice>;

  return (
    <>
      <h1>Seus espaços</h1>
      {tree.data.spaces.length === 0 ? (
        <p className="lead">
          {isOwner
            ? 'Ainda não existe nenhum espaço. Crie o primeiro abaixo: um espaço é uma grande área da empresa, como Operação ou Financeiro.'
            : 'Você ainda não tem acesso a nenhuma lista. Peça a um Dono ou ADM para liberar as áreas em que você trabalha.'}
        </p>
      ) : null}
      {tree.data.spaces.map((space) => (
        <section key={space.id} className="space">
          <h2>{space.name}</h2>
          <Lists
            lists={tree.data.lists.filter((l) => l.spaceId === space.id && l.folderId === null)}
          />
          {tree.data.folders
            .filter((folder) => folder.spaceId === space.id)
            .map((folder) => (
              <div key={folder.id} className="folder">
                <h3>{folder.name}</h3>
                <Lists lists={tree.data.lists.filter((l) => l.folderId === folder.id)} />
              </div>
            ))}
          {space.canManage ||
          tree.data.folders.some((f) => f.spaceId === space.id && f.canManage) ? (
            <AddInside
              spaceId={space.id}
              spaceName={space.name}
              atRoot={space.canManage}
              folders={tree.data.folders.filter((f) => f.spaceId === space.id && f.canManage)}
            />
          ) : null}
        </section>
      ))}
      {isOwner ? <AddSpace /> : null}
    </>
  );
}

function Lists({ lists }: { lists: Tree['lists'] }): ReactNode {
  if (lists.length === 0) return null;
  return (
    <ul className="rows">
      {lists.map((list) => (
        <li key={list.id}>
          <span>
            <Link to={`/listas/${list.id}`} current={false}>
              {list.name}
            </Link>
            {list.isSensitive ? <span className="tag tag-brand">sensível</span> : null}
          </span>
          <span className="muted">
            {LEVEL_NAMES[list.level]}
            {list.itemScope === 'assigned' ? ', só os seus itens' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AddSpace(): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const add = useAction(
    useCallback(async () => {
      await api.createSpace(name);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['tree'] });
    }, [name, queryClient]),
  );
  return (
    <section className="panel">
      <h2>Novo espaço</h2>
      <Form onSubmit={add.run}>
        <Field
          label="Nome do espaço"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={200}
        />
        {add.error ? <Notice tone="error">{add.error}</Notice> : null}
        <Button type="submit" busy={add.busy} disabled={name.trim() === ''}>
          Criar espaço
        </Button>
      </Form>
    </section>
  );
}

function AddInside({
  spaceId,
  spaceName,
  atRoot,
  folders,
}: {
  spaceId: string;
  spaceName: string;
  /** Manages the whole space: folders, and lists outside any folder. */
  atRoot: boolean;
  /** Folders where this person may create lists. */
  folders: Tree['folders'];
}): ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'list' | 'folder'>('list');
  const [name, setName] = useState('');
  // Someone who manages only folders starts in the first of them.
  const [folderId, setFolderId] = useState(atRoot ? '' : (folders[0]?.id ?? ''));
  const [isSensitive, setSensitive] = useState(false);
  const add = useAction(
    useCallback(async () => {
      if (kind === 'folder') await api.createFolder({ spaceId, name });
      else
        await api.createList({
          spaceId,
          folderId: folderId === '' ? null : folderId,
          name,
          isSensitive,
        });
      setName('');
      setSensitive(false);
      await queryClient.invalidateQueries({ queryKey: ['tree'] });
    }, [kind, spaceId, name, folderId, isSensitive, queryClient]),
  );

  if (!open) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        {atRoot ? 'Adicionar lista ou pasta' : 'Adicionar lista'}
        <span className="visually-hidden"> em {spaceName}</span>
      </Button>
    );
  }
  return (
    <Form onSubmit={add.run}>
      <div className="inline-fields">
        {atRoot ? (
          <Select
            label="O que criar"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'list', label: 'Lista' },
              { value: 'folder', label: 'Pasta' },
            ]}
          />
        ) : null}
        <Field
          label="Nome"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={200}
        />
        {kind === 'list' && folders.length > 0 && (atRoot || folders.length > 1) ? (
          <Select
            label="Onde"
            value={folderId}
            onChange={setFolderId}
            options={[
              ...(atRoot ? [{ value: '', label: 'Direto no espaço' }] : []),
              ...folders.map((folder) => ({ value: folder.id, label: `Pasta ${folder.name}` })),
            ]}
          />
        ) : null}
      </div>
      {kind === 'list' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={isSensitive}
            onChange={(event) => {
              setSensitive(event.target.checked);
            }}
          />
          Lista sensível: pede o código do autenticador de novo para abrir, e cada abertura fica
          registrada
        </label>
      ) : null}
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
      <div className="actions">
        <Button type="submit" busy={add.busy} disabled={name.trim() === ''}>
          {kind === 'list' ? 'Criar lista' : 'Criar pasta'}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(false);
          }}
        >
          Fechar
        </Button>
      </div>
    </Form>
  );
}
