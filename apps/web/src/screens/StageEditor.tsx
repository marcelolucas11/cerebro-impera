import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, ApiError, type Stage, type StageKind } from '../api.js';
import { STAGE_KIND_NAMES } from '../labels.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

const KIND_OPTIONS = (Object.keys(STAGE_KIND_NAMES) as StageKind[]).map((value) => ({
  value,
  label: STAGE_KIND_NAMES[value],
}));

/** Where whoever manages a list shapes the stages its items go through. */
export function StageEditor({ listId, stages }: { listId: string; stages: Stage[] }): ReactNode {
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['stages', listId] });
    await queryClient.invalidateQueries({ queryKey: ['items', listId] });
  }, [queryClient, listId]);

  const move = useAction(
    useCallback(
      async (index: number, by: -1 | 1) => {
        const ids = stages.map((stage) => stage.id);
        const [moved] = ids.splice(index, 1);
        if (moved === undefined) return;
        ids.splice(index + by, 0, moved);
        await api.reorderStages(listId, ids);
        await refresh();
      },
      [stages, listId, refresh],
    ),
  );

  return (
    <section className="panel" aria-label="Etapas desta lista">
      <h2>Etapas desta lista</h2>
      <p className="lead">
        As etapas são os grupos em que os itens aparecem, na ordem abaixo. O significado diz ao
        sistema como contar cada etapa nos totais, qualquer que seja o nome.
      </p>
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
      <ol className="stage-editor">
        {stages.map((stage, index) => (
          <StageRow
            key={stage.id}
            stage={stage}
            others={stages.filter((other) => other.id !== stage.id)}
            onMove={(by) => {
              move.run(index, by);
            }}
            canMoveUp={index > 0 && !move.busy}
            canMoveDown={index < stages.length - 1 && !move.busy}
            onChanged={refresh}
          />
        ))}
      </ol>
      <AddStage listId={listId} onAdded={refresh} />
    </section>
  );
}

function StageRow({
  stage,
  others,
  onMove,
  canMoveUp,
  canMoveDown,
  onChanged,
}: {
  stage: Stage;
  others: Stage[];
  onMove: (by: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [kind, setKind] = useState<StageKind>(stage.kind);
  // Set when the stage still holds items: they need somewhere to go first.
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const changed = name.trim() !== stage.name || color !== stage.color || kind !== stage.kind;

  const save = useAction(
    useCallback(async () => {
      await api.updateStage(stage.id, { name: name.trim(), color, kind });
      await onChanged();
    }, [stage.id, name, color, kind, onChanged]),
  );
  const remove = useAction(
    useCallback(async () => {
      try {
        await api.deleteStage(stage.id, moveTo ?? undefined);
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'stage_in_use' && moveTo === null) {
          setMoveTo(others[0]?.id ?? null);
          return;
        }
        throw failure;
      }
      await onChanged();
    }, [stage.id, moveTo, others, onChanged]),
  );

  return (
    <li>
      <div className="stage-fields">
        <Field
          label="Nome"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={60}
        />
        <Field
          label="Cor"
          type="color"
          value={color}
          onChange={(event) => {
            setColor(event.target.value);
          }}
        />
        <Select label="Significado" value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </div>
      <div className="actions">
        <Button
          variant="quiet"
          busy={save.busy}
          disabled={!changed || name.trim() === ''}
          onClick={save.run}
        >
          Salvar etapa
        </Button>
        <Button
          variant="quiet"
          disabled={!canMoveUp}
          onClick={() => {
            onMove(-1);
          }}
        >
          Subir<span className="visually-hidden"> {stage.name}</span>
        </Button>
        <Button
          variant="quiet"
          disabled={!canMoveDown}
          onClick={() => {
            onMove(1);
          }}
        >
          Descer<span className="visually-hidden"> {stage.name}</span>
        </Button>
        {others.length > 0 && moveTo === null ? (
          <Button variant="quiet" busy={remove.busy} onClick={remove.run}>
            Remover<span className="visually-hidden"> {stage.name}</span>
          </Button>
        ) : null}
      </div>
      {moveTo !== null ? (
        <div className="subsection">
          <Notice tone="info">
            Ainda há itens nesta etapa. Escolha para onde eles vão antes de removê-la.
          </Notice>
          <div className="inline-fields">
            <Select
              label={`Mover os itens de ${stage.name} para`}
              value={moveTo}
              onChange={setMoveTo}
              options={others.map((other) => ({ value: other.id, label: other.name }))}
            />
          </div>
          <div className="actions">
            <Button busy={remove.busy} onClick={remove.run}>
              Mover os itens e remover
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setMoveTo(null);
              }}
            >
              Manter a etapa
            </Button>
          </div>
        </div>
      ) : null}
      {(save.error ?? remove.error) ? (
        <Notice tone="error">{save.error ?? remove.error}</Notice>
      ) : null}
    </li>
  );
}

function AddStage({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#9ba6b8');
  const [kind, setKind] = useState<StageKind>('active');
  const add = useAction(
    useCallback(async () => {
      await api.createStage(listId, { name: name.trim(), color, kind });
      setName('');
      await onAdded();
    }, [listId, name, color, kind, onAdded]),
  );
  return (
    <Form onSubmit={add.run}>
      <h3>Nova etapa</h3>
      <div className="stage-fields">
        <Field
          label="Nome da nova etapa"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={60}
        />
        <Field
          label="Cor da nova etapa"
          type="color"
          value={color}
          onChange={(event) => {
            setColor(event.target.value);
          }}
        />
        <Select
          label="Significado da nova etapa"
          value={kind}
          onChange={setKind}
          options={KIND_OPTIONS}
        />
      </div>
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
      <Button type="submit" busy={add.busy} disabled={name.trim() === ''}>
        Adicionar etapa
      </Button>
    </Form>
  );
}
