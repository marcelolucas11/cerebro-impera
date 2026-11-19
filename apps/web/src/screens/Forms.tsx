import { isFormFieldKind, type FormInput, type FormView } from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { api, type CustomField, type Stage } from '../api.js';
import { describeError } from '../messages.js';
import { useGuard } from '../stepup.js';
import { Button, CopyButton, Exact, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

/*
 * Public forms of a list: a page anyone with the address fills in, whose
 * answer arrives here as an item. Whoever manages the list makes them, with
 * the code confirmed again; a form sends with the access of whoever saved it
 * last, and asks only fields strangers may fill in.
 */

const blank = (): FormInput => ({
  title: '',
  intro: '',
  titleLabel: 'Seu nome',
  descriptionLabel: null,
  fields: [],
  stageId: null,
  enabled: true,
});

const inputOf = (form: FormView): FormInput => ({
  title: form.title,
  intro: form.intro,
  titleLabel: form.titleLabel,
  descriptionLabel: form.descriptionLabel,
  fields: form.fields,
  stageId: form.stageId,
  enabled: form.enabled,
});

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function Forms({
  listId,
  stages,
  fields,
}: {
  listId: string;
  stages: Stage[] | undefined;
  fields: CustomField[] | undefined;
}): ReactNode {
  const queryClient = useQueryClient();
  const guard = useGuard();
  const forms = useQuery({ queryKey: ['forms', listId], queryFn: () => api.forms(listId) });
  const [editing, setEditing] = useState<FormView | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['forms', listId] }),
    [queryClient, listId],
  );

  const toggle = useAction(
    useCallback(
      async (form: FormView) => {
        await guard(() => api.updateForm(form.id, { ...inputOf(form), enabled: !form.enabled }));
        await refresh();
      },
      [guard, refresh],
    ),
  );
  const remove = useAction(
    useCallback(
      async (id: string) => {
        await guard(() => api.removeForm(id));
        setRemoving(null);
        await refresh();
      },
      [guard, refresh],
    ),
  );

  if (forms.isPending) return <p className="lead">Abrindo…</p>;
  if (forms.isError) return <Notice tone="error">{describeError(forms.error)}</Notice>;

  return (
    <section className="forms" aria-label="Formulários públicos">
      <h2>Formulários públicos</h2>
      <p className="lead">
        Uma página que qualquer pessoa com o endereço preenche, e a resposta chega aqui como um
        item. Quem responde não vê nada da lista, só as perguntas que você escolher.
      </p>
      {forms.data.length > 0 && forms.data.every((form) => form.address === null) ? (
        <Notice tone="info">
          Esta instalação ainda não tem o endereço dos formulários. Quem cuida do servidor liga o
          serviço "forms" (veja infra/README.md). Até lá, os formulários ficam guardados aqui, sem
          endereço.
        </Notice>
      ) : null}
      {toggle.error ? <Notice tone="error">{toggle.error}</Notice> : null}
      {remove.error ? <Notice tone="error">{remove.error}</Notice> : null}

      {forms.data.length === 0 && editing === null ? (
        <p className="field-note">Nenhum formulário nesta lista ainda.</p>
      ) : null}
      <ul className="rules">
        {forms.data.map((form) => (
          <li key={form.id} className={form.enabled ? 'rule' : 'rule is-paused'}>
            <p className="rule-head">
              <strong>{form.title}</strong>
              <span className="rule-state">
                {form.enabled ? 'Recebendo respostas' : 'Desligado'}
              </span>
            </p>
            {form.address !== null ? (
              <p className="form-address">
                <Exact>{form.address}</Exact>
                <CopyButton text={form.address} label="Copiar endereço" />
              </p>
            ) : null}
            <p className="rule-state">
              {`${count(form.sentToday, 'resposta', 'respostas')} nas últimas 24 horas, ${String(form.sentTotal)} no total.`}
            </p>
            <div className="rule-actions">
              <Button
                variant="quiet"
                onClick={() => {
                  setEditing(form);
                }}
              >
                Editar
              </Button>
              <Button
                variant="quiet"
                busy={toggle.busy}
                onClick={() => {
                  toggle.run(form);
                }}
              >
                {form.enabled ? 'Desligar' : 'Ligar'}
              </Button>
              {removing === form.id ? (
                <Button
                  variant="quiet"
                  busy={remove.busy}
                  onClick={() => {
                    remove.run(form.id);
                  }}
                >
                  Remover de vez
                </Button>
              ) : (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setRemoving(form.id);
                  }}
                >
                  Remover
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <Button
          onClick={() => {
            setEditing('new');
          }}
        >
          Novo formulário
        </Button>
      ) : (
        <FormEditor
          key={editing === 'new' ? 'new' : editing.id}
          listId={listId}
          form={editing === 'new' ? null : editing}
          stages={stages ?? []}
          fields={fields ?? []}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function FormEditor({
  listId,
  form,
  stages,
  fields,
  onDone,
}: {
  listId: string;
  form: FormView | null;
  stages: Stage[];
  fields: CustomField[];
  onDone: () => void;
}): ReactNode {
  const guard = useGuard();
  const [draft, setDraft] = useState<FormInput>(form === null ? blank() : inputOf(form));
  const [askDescription, setAskDescription] = useState(draft.descriptionLabel !== null);
  const [descriptionLabel, setDescriptionLabel] = useState(draft.descriptionLabel ?? 'Conte mais');
  const intro = useId();
  const askable = fields.filter((field) => !field.archived && isFormFieldKind(field.kind));
  const left = fields.filter((field) => !field.archived && !isFormFieldKind(field.kind));
  const set = <K extends keyof FormInput>(key: K, value: FormInput[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const asked = (id: string) => draft.fields.find((field) => field.id === id);
  const ask = (id: string, on: boolean): void => {
    set(
      'fields',
      on
        ? // Kept in the list's own order.
          askable
            .filter((field) => field.id === id || asked(field.id) !== undefined)
            .map((field) => asked(field.id) ?? { id: field.id, required: false })
        : draft.fields.filter((field) => field.id !== id),
    );
  };
  const require = (id: string, on: boolean): void => {
    set(
      'fields',
      draft.fields.map((field) => (field.id === id ? { ...field, required: on } : field)),
    );
  };

  const save = useAction(
    useCallback(async () => {
      const input: FormInput = {
        ...draft,
        title: draft.title.trim(),
        intro: draft.intro.trim(),
        titleLabel: draft.titleLabel.trim(),
        descriptionLabel: askDescription ? descriptionLabel.trim() : null,
      };
      await guard(() =>
        form === null ? api.createForm(listId, input) : api.updateForm(form.id, input),
      );
      onDone();
    }, [draft, askDescription, descriptionLabel, guard, form, listId, onDone]),
  );
  const ready =
    draft.title.trim() !== '' &&
    draft.titleLabel.trim() !== '' &&
    (!askDescription || descriptionLabel.trim() !== '');

  return (
    <div className="rule-form">
      <h3>{form === null ? 'Novo formulário' : `Editar “${form.title}”`}</h3>
      <Form onSubmit={save.run}>
        <Field
          label="Título do formulário"
          value={draft.title}
          maxLength={120}
          onChange={(event) => {
            set('title', event.target.value);
          }}
        />
        <div className="field">
          <label htmlFor={intro}>Texto de apresentação (opcional)</label>
          <textarea
            id={intro}
            rows={3}
            maxLength={2000}
            value={draft.intro}
            onChange={(event) => {
              set('intro', event.target.value);
            }}
          />
        </div>
        <Field
          label="Pergunta cuja resposta vira o título do item"
          hint="Por exemplo: Seu nome, Assunto, Nome da empresa."
          value={draft.titleLabel}
          maxLength={120}
          onChange={(event) => {
            set('titleLabel', event.target.value);
          }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={askDescription}
            onChange={(event) => {
              setAskDescription(event.target.checked);
            }}
          />
          <span>Pedir também um texto livre, que vira a descrição do item</span>
        </label>
        {askDescription ? (
          <Field
            label="Pergunta do texto livre"
            value={descriptionLabel}
            maxLength={120}
            onChange={(event) => {
              setDescriptionLabel(event.target.value);
            }}
          />
        ) : null}

        <fieldset className="rule-part">
          <legend>Campos da lista que o formulário pergunta</legend>
          {askable.length === 0 ? (
            <p className="field-note">
              Esta lista não tem campos que um formulário possa perguntar.
            </p>
          ) : (
            <ul className="form-questions">
              {askable.map((field) => {
                const entry = asked(field.id);
                return (
                  <li key={field.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={entry !== undefined}
                        onChange={(event) => {
                          ask(field.id, event.target.checked);
                        }}
                      />
                      <span>{field.name}</span>
                    </label>
                    {entry !== undefined ? (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={entry.required}
                          onChange={(event) => {
                            require(field.id, event.target.checked);
                          }}
                        />
                        <span>Obrigatória</span>
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {left.length > 0 ? (
            <p className="field-note">
              {`Ficam de fora, porque mostrariam algo de dentro ou pediriam arquivo: ${left.map((field) => field.name).join(', ')}.`}
            </p>
          ) : null}
        </fieldset>

        <Select
          label="Onde o item chega"
          value={draft.stageId ?? ''}
          options={[
            { value: '', label: 'Na primeira etapa' },
            ...stages.map((stage) => ({ value: stage.id, label: stage.name })),
          ]}
          onChange={(value) => {
            set('stageId', value === '' ? null : value);
          }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => {
              set('enabled', event.target.checked);
            }}
          />
          <span>Recebendo respostas</span>
        </label>
        <p className="field-note">
          Os itens chegam como seus, marcados como do formulário. Se você deixar de poder criar
          itens nesta lista, o formulário para de receber.
        </p>
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        <div className="brand-actions">
          <Button type="submit" busy={save.busy} disabled={!ready}>
            Salvar formulário
          </Button>
          <Button variant="quiet" onClick={onDone}>
            Cancelar
          </Button>
        </div>
      </Form>
    </div>
  );
}
