import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api, type Stage } from '../api.js';
import { Button, Field, Form, Notice, useAction } from '../ui/kit.js';

/** A new item, straight into a stage: from the list and from the board alike. */
export function AddItem({ stage }: { stage: Stage }): ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const add = useAction(
    useCallback(async () => {
      await api.createItem(stage.listId, { title: title.trim(), stageId: stage.id });
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: ['items', stage.listId] });
    }, [stage.listId, stage.id, title, queryClient]),
  );
  // Closed by default, so a long list stays a list and not a stack of forms.
  if (!open) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(true);
        }}
      >
        Adicionar item<span className="visually-hidden"> em {stage.name}</span>
      </Button>
    );
  }
  return (
    <Form onSubmit={add.run}>
      <div className="add-item">
        <Field
          label={`Novo item em ${stage.name}`}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          maxLength={500}
          autoFocus
        />
        <Button type="submit" busy={add.busy} disabled={title.trim() === ''}>
          Adicionar
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
      {add.error ? <Notice tone="error">{add.error}</Notice> : null}
    </Form>
  );
}
