import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type Stage } from '../api.js';
import { useGuard } from '../stepup.js';
import { Button, Notice, Select, useAction } from '../ui/kit.js';

/*
 * A change to several items at once: move them to a stage, pass them to a
 * person (for who hands out work in the list), or send them to the trash. Several to the trash asks for the code again, needs the "bulk
 * delete" capability, and the owners are told.
 */
export function BulkBar({
  listId,
  ids,
  stages,
  workers,
  canBulkDelete,
  onDone,
}: {
  listId: string;
  ids: string[];
  stages: Stage[];
  /** Who can take work here; null when the caller does not hand out work. */
  workers: { id: string; name: string }[] | null;
  canBulkDelete: boolean;
  onDone: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const [stageId, setStageId] = useState('');
  const [userId, setUserId] = useState('');
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['items', listId] });
    await queryClient.invalidateQueries({ queryKey: ['trash', listId] });
  }, [listId, queryClient]);
  const move = useAction(
    useCallback(async () => {
      await guard(() => api.bulk(listId, { action: 'stage', ids, stageId }));
      await refresh();
      onDone();
    }, [guard, listId, ids, stageId, refresh, onDone]),
  );
  const assign = useAction(
    useCallback(async () => {
      await guard(() => api.bulk(listId, { action: 'assign', ids, userId }));
      await refresh();
      onDone();
    }, [guard, listId, ids, userId, refresh, onDone]),
  );
  const trash = useAction(
    useCallback(async () => {
      await guard(() => api.bulk(listId, { action: 'trash', ids }));
      await refresh();
      onDone();
    }, [guard, listId, ids, refresh, onDone]),
  );
  const many = ids.length > 1;
  return (
    <section className="bulk-bar" aria-label="Itens selecionados">
      <p className="bulk-count">
        {many ? `${ids.length} itens selecionados` : '1 item selecionado'}
      </p>
      <div className="list-tools-row">
        <Select
          label="Mover para a etapa"
          value={stageId}
          onChange={setStageId}
          options={[
            { value: '', label: 'Escolha a etapa' },
            ...stages.map((stage) => ({ value: stage.id, label: stage.name })),
          ]}
        />
        <Button variant="quiet" busy={move.busy} disabled={stageId === ''} onClick={move.run}>
          Mover selecionados
        </Button>
      </div>
      {workers !== null ? (
        <div className="list-tools-row">
          <Select
            label="Passar para"
            value={userId}
            onChange={setUserId}
            options={[
              { value: '', label: 'Escolha a pessoa' },
              ...workers.map((person) => ({ value: person.id, label: person.name })),
            ]}
          />
          <Button variant="quiet" busy={assign.busy} disabled={userId === ''} onClick={assign.run}>
            Passar selecionados
          </Button>
        </div>
      ) : null}
      <div className="list-tools-row">
        {!many || canBulkDelete ? (
          <Button variant="quiet" busy={trash.busy} onClick={trash.run}>
            Mandar selecionados para a lixeira
          </Button>
        ) : null}
        <Button variant="quiet" onClick={onDone}>
          Limpar seleção
        </Button>
      </div>
      {many && !canBulkDelete ? (
        <p className="field-note">
          Mandar vários itens de uma vez para a lixeira é só para quem tem a capacidade “Apagar em
          massa”. Um por vez continua possível.
        </p>
      ) : many ? (
        <p className="field-note">
          Mandar vários de uma vez pede o código do autenticador e avisa os Donos.
        </p>
      ) : null}
      {move.error ? <Notice tone="error">{move.error}</Notice> : null}
      {assign.error ? <Notice tone="error">{assign.error}</Notice> : null}
      {trash.error ? <Notice tone="error">{trash.error}</Notice> : null}
    </section>
  );
}
