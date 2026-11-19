import { MAX_SECRET_LENGTH, secretValueProblem } from '@cerebro/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { api, type CustomField, type Item } from '../api.js';
import { copySensitive } from '../clipboard.js';
import { useGuard } from '../stepup.js';
import { Button, Exact, Notice, useAction } from '../ui/kit.js';

/** How long a revealed value stays on screen. */
const SHOWN_FOR_MS = 30_000;

/*
 * One secret field of an item. The page never has the value until someone
 * asks for it; asking needs a recent authenticator code and is on the record.
 * A revealed value hides itself again after half a minute.
 */
export function SecretField({
  item,
  field,
  canEdit,
  canReveal,
}: {
  item: Item;
  field: CustomField;
  canEdit: boolean;
  /** Owners, and whoever an owner gave the capability to reveal secrets. */
  canReveal: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const inputId = useId();
  const isSet = item.secrets.includes(field.id);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Whatever was revealed goes away on its own, and when the item changes.
  useEffect(() => {
    if (shown === null) return undefined;
    const timer = setTimeout(() => {
      setShown(null);
    }, SHOWN_FOR_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [shown]);
  useEffect(() => {
    setShown(null);
    setCopied(false);
  }, [item.id, isSet]);

  const fetchValue = useCallback(
    async () => (await guard(() => api.revealSecret(item.id, field.id))).value,
    [guard, item.id, field.id],
  );
  const reveal = useAction(
    useCallback(async () => {
      setCopied(false);
      setShown(await fetchValue());
    }, [fetchValue]),
  );
  const copy = useAction(
    useCallback(async () => {
      const value = await fetchValue();
      await copySensitive(value);
      setCopied(true);
    }, [fetchValue]),
  );
  const save = useAction(
    useCallback(
      async (value: string | null) => {
        await api.setSecret(item.id, field.id, value);
        setEditing(false);
        setDraft('');
        await queryClient.invalidateQueries({ queryKey: ['items', item.listId] });
      },
      [item.id, item.listId, field.id, queryClient],
    ),
  );
  const error = reveal.error ?? copy.error ?? save.error;

  return (
    <div className="secret-field">
      <div className="secret-line">
        <span className="secret-name">{field.name}</span>
        {!isSet ? <span className="muted">Vazio</span> : null}
        {isSet && shown === null ? (
          <span className="secret-mask">
            <span aria-hidden="true">••••••••</span>
            <span className="visually-hidden">Valor guardado, escondido</span>
          </span>
        ) : null}
        {isSet && shown !== null ? <Exact>{shown}</Exact> : null}
      </div>
      <div className="file-actions">
        {canReveal && isSet && shown === null ? (
          <Button variant="quiet" busy={reveal.busy} onClick={reveal.run}>
            Revelar<span className="visually-hidden"> {field.name}</span>
          </Button>
        ) : null}
        {shown !== null ? (
          <Button
            variant="quiet"
            onClick={() => {
              setShown(null);
            }}
          >
            Esconder<span className="visually-hidden"> {field.name}</span>
          </Button>
        ) : null}
        {canReveal && isSet ? (
          <Button variant="quiet" busy={copy.busy} onClick={copy.run}>
            Copiar sem mostrar<span className="visually-hidden"> {field.name}</span>
          </Button>
        ) : null}
        {canEdit && !editing ? (
          <Button
            variant="quiet"
            onClick={() => {
              setEditing(true);
            }}
          >
            {isSet ? 'Trocar' : 'Preencher'}
            <span className="visually-hidden"> {field.name}</span>
          </Button>
        ) : null}
        {canEdit && isSet && !editing ? (
          <Button
            variant="quiet"
            busy={save.busy}
            onClick={() => {
              save.run(null);
            }}
          >
            Apagar valor<span className="visually-hidden"> de {field.name}</span>
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="secret-edit">
          <div className="field">
            <label htmlFor={inputId}>Novo valor de {field.name}</label>
            <input
              id={inputId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={MAX_SECRET_LENGTH}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && secretValueProblem(draft) === null) save.run(draft);
              }}
            />
          </div>
          <div className="file-actions">
            <Button
              variant="quiet"
              busy={save.busy}
              disabled={secretValueProblem(draft) !== null}
              onClick={() => {
                save.run(draft);
              }}
            >
              Guardar<span className="visually-hidden"> {field.name}</span>
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setEditing(false);
                setDraft('');
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
      {copied ? (
        <Notice tone="ok">
          Copiado. Cole onde precisar em até 30 segundos: depois disso a área de transferência é
          limpa. O valor não apareceu na tela.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
