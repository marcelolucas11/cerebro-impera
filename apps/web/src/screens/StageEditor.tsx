import { STAGE_PRESETS } from '@cerebro/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, ApiError, type Stage, type StageEntryRole, type StageKind } from '../api.js';
import { ENTRY_NAMES } from '../entry.js';
import { STAGE_KIND_NAMES } from '../labels.js';
import { download, readStageFile, stageFileName, stageFileOf } from '../stagefile.js';
import { useGuard } from '../stepup.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

const KIND_OPTIONS = (Object.keys(STAGE_KIND_NAMES) as StageKind[]).map((value) => ({
  value,
  label: STAGE_KIND_NAMES[value],
}));
const ENTRY_OPTIONS = (Object.keys(ENTRY_NAMES) as (StageEntryRole | 'anyone')[]).map((value) => ({
  value,
  label: ENTRY_NAMES[value],
}));

/** Where whoever manages a list shapes the stages its items go through. */
export function StageEditor({
  listId,
  listName,
  stages,
  otherLists,
}: {
  listId: string;
  listName: string;
  stages: Stage[];
  otherLists: { id: string; label: string }[];
}): ReactNode {
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
      <StageSets
        listId={listId}
        listName={listName}
        stages={stages}
        otherLists={otherLists}
        onApplied={refresh}
      />
    </section>
  );
}

/**
 * Starting from a ready-made set, another list's stages or a saved file, and
 * saving this list's stages to use elsewhere. Applying never removes a stage.
 */
function StageSets({
  listId,
  listName,
  stages,
  otherLists,
  onApplied,
}: {
  listId: string;
  listName: string;
  stages: Stage[];
  otherLists: { id: string; label: string }[];
  onApplied: () => Promise<void>;
}): ReactNode {
  const guard = useGuard();
  const fileId = useId();
  const [source, setSource] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const options = [
    { value: '', label: 'Escolha um modelo' },
    ...STAGE_PRESETS.map((preset, index) => ({
      value: `modelo:${index}`,
      label: `Modelo pronto: ${preset.name}`,
    })),
    ...otherLists.map((list) => ({ value: `lista:${list.id}`, label: `Etapas de ${list.label}` })),
  ];

  const applyDrafts = useCallback(
    async (drafts: { name: string; color: string; kind: StageKind }[], what: string) => {
      setDone(null);
      await api.applyStages(listId, drafts);
      await onApplied();
      setDone(`${what}: etapas aplicadas. Nenhuma etapa foi removida.`);
    },
    [listId, onApplied],
  );
  const applyImported = useAction(applyDrafts);
  const applyChosen = useAction(
    useCallback(async () => {
      if (source.startsWith('modelo:')) {
        const preset = STAGE_PRESETS[Number(source.slice('modelo:'.length))];
        if (preset) await applyDrafts([...preset.stages], `Modelo ${preset.name}`);
        return;
      }
      const otherId = source.slice('lista:'.length);
      // The stages of a sensitive list are read only after the authenticator code.
      const theirs = await guard(() => api.stages(otherId));
      const label = otherLists.find((list) => list.id === otherId)?.label ?? 'Outra lista';
      await applyDrafts(
        theirs.map(({ name, color, kind }) => ({ name, color, kind })),
        label,
      );
    }, [source, applyDrafts, guard, otherLists]),
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const importFile = (event: ChangeEvent<HTMLInputElement>): void => {
    setFileError(null);
    setDone(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then((text) => {
      const read = readStageFile(text);
      if (!read.ok) {
        setFileError(read.message);
        return;
      }
      applyImported.run(read.file.stages, `Arquivo "${read.file.name}"`);
    });
  };

  return (
    <div className="subsection">
      <h3>Modelos de etapas</h3>
      <p className="field-note">
        Aplicar um modelo cria as etapas que faltam e ajusta a cor e o significado das que têm o
        mesmo nome. Nenhuma etapa é removida, e nenhum item muda de etapa.
      </p>
      <div className="move-to">
        <Select label="Modelo de etapas" value={source} onChange={setSource} options={options} />
        <Button
          variant="quiet"
          busy={applyChosen.busy}
          disabled={source === ''}
          onClick={applyChosen.run}
        >
          Aplicar modelo
        </Button>
      </div>
      <div className="actions">
        <Button
          variant="quiet"
          onClick={() => {
            download(
              stageFileName(listName),
              `${JSON.stringify(stageFileOf(listName, stages), null, 2)}\n`,
            );
          }}
        >
          Exportar estas etapas
        </Button>
        <label className="file-button" htmlFor={fileId}>
          Importar etapas de um arquivo
        </label>
        <input
          id={fileId}
          className="visually-hidden"
          type="file"
          accept=".json,application/json"
          onChange={importFile}
        />
      </div>
      {fileError ? <Notice tone="error">{fileError}</Notice> : null}
      {(applyChosen.error ?? applyImported.error) ? (
        <Notice tone="error">{applyChosen.error ?? applyImported.error}</Notice>
      ) : null}
      {done !== null ? <Notice tone="ok">{done}</Notice> : null}
    </div>
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
  const [entry, setEntry] = useState<StageEntryRole | 'anyone'>(stage.entryRole ?? 'anyone');
  const changed =
    name.trim() !== stage.name ||
    color !== stage.color ||
    kind !== stage.kind ||
    entry !== (stage.entryRole ?? 'anyone');

  const save = useAction(
    useCallback(async () => {
      await api.updateStage(stage.id, {
        name: name.trim(),
        color,
        kind,
        entryRole: entry === 'anyone' ? null : entry,
      });
      await onChanged();
    }, [stage.id, name, color, kind, entry, onChanged]),
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
        <Select
          label="Quem põe itens aqui"
          value={entry}
          onChange={setEntry}
          options={ENTRY_OPTIONS}
        />
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
