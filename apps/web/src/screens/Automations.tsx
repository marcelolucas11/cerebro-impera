import {
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_COMMENT,
  MAX_AUTOMATION_CONDITIONS,
  MAX_AUTOMATION_NOTIFY,
} from '@cerebro/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  type Automation,
  type AutomationInput,
  type CustomField,
  type RuleAudience,
  type Stage,
} from '../api.js';
import { PRIORITY_NAMES } from '../due.js';
import { formatWhen } from '../labels.js';
import { describeError } from '../messages.js';
import {
  actionDraft,
  actionOf,
  conditionDraft,
  conditionOf,
  OUTCOME_NAMES,
  ruleSentence,
  runReason,
  triggerDraft,
  triggerOf,
  type ActionDraft,
  type ActionKind,
  type ConditionDraft,
  type RuleContext,
  type TriggerDraft,
} from '../rules.js';
import { Button, Field, Form, Notice, Select, useAction } from '../ui/kit.js';

/*
 * Rules of a list: when an item is created or enters a stage, and what holds,
 * then what happens. Whoever manages the list sees them; whoever also holds
 * the automations capability writes them. A rule acts with the access of
 * whoever saved it last.
 */

const PRIORITY_CHOICES = [
  { value: 'none', label: 'Sem prioridade' },
  ...[1, 2, 3, 4].map((value) => ({
    value: String(value),
    label: PRIORITY_NAMES[value] ?? String(value),
  })),
];
const ACTION_CHOICES: { value: ActionKind; label: string }[] = [
  { value: 'stage', label: 'Mover para a etapa' },
  { value: 'priority', label: 'Mudar a prioridade' },
  { value: 'assign', label: 'Passar para' },
  { value: 'notify', label: 'Avisar' },
  { value: 'comment', label: 'Comentar' },
];

/** Fields a rule may ask about: choices and checkboxes in use. */
const askable = (fields: CustomField[]): CustomField[] =>
  fields.filter(
    (field) => !field.archived && (field.kind === 'select' || field.kind === 'checkbox'),
  );

export function Automations({
  listId,
  stages,
  fields,
  canWrite,
  isSensitive,
  meId,
}: {
  listId: string;
  stages: Stage[];
  fields: CustomField[];
  canWrite: boolean;
  isSensitive: boolean;
  meId: string | undefined;
}): ReactNode {
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ['automations', listId],
    queryFn: () => api.automations(listId),
  });
  const audience = useQuery({
    queryKey: ['rule-audience', listId],
    queryFn: () => api.ruleAudience(listId),
  });
  const [adding, setAdding] = useState(false);
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['automations', listId] });
  }, [queryClient, listId]);

  const people = useMemo(() => audience.data ?? [], [audience.data]);
  const context = useMemo<RuleContext>(
    () => ({
      stageName: (id) => stages.find((stage) => stage.id === id)?.name,
      personName: (id) => people.find((person) => person.id === id)?.name,
      fieldName: (id) => fields.find((field) => field.id === id)?.name,
      optionName: (fieldId, optionId) =>
        fields
          .find((field) => field.id === fieldId)
          ?.config.options?.find((option) => option.id === optionId)?.name,
    }),
    [stages, people, fields],
  );

  return (
    <section className="panel" aria-label="Automações desta lista">
      <h2>Automações desta lista</h2>
      <p className="lead">
        Uma regra age sozinha quando um item é criado ou entra numa etapa. Ela age com o acesso de
        quem a salvou por último, nunca com mais, e não desfaz o que a pessoa fez: quando não
        consegue agir, fica anotado no registro da regra.
      </p>
      {isSensitive ? (
        <Notice tone="info">
          Listas sensíveis não têm regras: nelas, tudo é feito por uma pessoa que confirmou o código
          do autenticador.
        </Notice>
      ) : null}
      {rules.isError ? <Notice tone="error">{describeError(rules.error)}</Notice> : null}
      {rules.data !== undefined && rules.data.length === 0 && !isSensitive ? (
        <p className="muted">Nenhuma regra ainda.</p>
      ) : null}
      {rules.data !== undefined && rules.data.length > 0 ? (
        <ol className="rules">
          {rules.data.map((rule) => (
            <RuleEntry
              key={rule.id}
              rule={rule}
              context={context}
              canWrite={canWrite}
              mine={rule.runAs === meId}
              stages={stages}
              fields={fields}
              people={people}
              onChanged={refresh}
            />
          ))}
        </ol>
      ) : null}
      {canWrite && !isSensitive ? (
        adding ? (
          <RuleForm
            title="Nova regra"
            stages={stages}
            fields={fields}
            people={people}
            onCancel={() => {
              setAdding(false);
            }}
            onSave={async (input) => {
              await api.createAutomation(listId, input);
              await refresh();
              setAdding(false);
            }}
          />
        ) : (
          <div className="actions">
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              Criar regra
            </Button>
          </div>
        )
      ) : null}
      {!canWrite && !isSensitive ? (
        <p className="field-note">
          Para criar ou mudar regras, peça a quem cuida das pessoas a permissão de automações.
        </p>
      ) : null}
    </section>
  );
}

function RuleEntry({
  rule,
  context,
  canWrite,
  mine,
  stages,
  fields,
  people,
  onChanged,
}: {
  rule: Automation;
  context: RuleContext;
  canWrite: boolean;
  mine: boolean;
  stages: Stage[];
  fields: CustomField[];
  people: RuleAudience[];
  onChanged: () => Promise<void>;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toggle = useAction(
    useCallback(async () => {
      await api.updateAutomation(rule.id, { enabled: !rule.enabled });
      await onChanged();
    }, [rule.id, rule.enabled, onChanged]),
  );
  const remove = useAction(
    useCallback(async () => {
      await api.removeAutomation(rule.id);
      await onChanged();
    }, [rule.id, onChanged]),
  );

  if (editing) {
    return (
      <li className="rule">
        <RuleForm
          title={`Mudar “${rule.name}”`}
          initial={rule}
          stages={stages}
          fields={fields}
          people={people}
          onCancel={() => {
            setEditing(false);
          }}
          onSave={async (input) => {
            await api.updateAutomation(rule.id, input);
            await onChanged();
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className={rule.enabled ? 'rule' : 'rule is-paused'}>
      <p className="rule-head">
        <strong>{rule.name}</strong>
        {rule.enabled ? null : <span className="rule-state">Pausada</span>}
      </p>
      <p className="rule-sentence">{ruleSentence(rule, context)}</p>
      <p className="field-note">
        {mine ? 'Age com o seu acesso' : `Age com o acesso de ${rule.runAsName}`}
        {rule.lastRun === null
          ? '. Ainda não agiu.'
          : `. Última vez: ${OUTCOME_NAMES[rule.lastRun.outcome].toLowerCase()}, ${formatWhen(rule.lastRun.at)}.`}
      </p>
      {toggle.error ? <Notice tone="error">{toggle.error}</Notice> : null}
      {remove.error ? <Notice tone="error">{remove.error}</Notice> : null}
      <div className="rule-actions">
        <Button
          variant="quiet"
          aria-expanded={showRuns}
          onClick={() => {
            setShowRuns(!showRuns);
          }}
        >
          {showRuns ? 'Fechar o registro' : 'Ver o registro'}
        </Button>
        {canWrite ? (
          <>
            <Button variant="quiet" busy={toggle.busy} onClick={toggle.run}>
              {rule.enabled ? 'Pausar' : 'Ligar'}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setEditing(true);
              }}
            >
              Mudar
            </Button>
            {confirming ? (
              <>
                <Button variant="quiet" busy={remove.busy} onClick={remove.run}>
                  Apagar “{rule.name}” de vez
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Manter
                </Button>
              </>
            ) : (
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Apagar
              </Button>
            )}
          </>
        ) : null}
      </div>
      {canWrite && !mine ? (
        <p className="field-note">Pausar, ligar ou mudar a regra faz ela agir com o seu acesso.</p>
      ) : null}
      {showRuns ? <RuleRuns ruleId={rule.id} /> : null}
    </li>
  );
}

function RuleRuns({ ruleId }: { ruleId: string }): ReactNode {
  const runs = useQuery({
    queryKey: ['automation-runs', ruleId],
    queryFn: () => api.automationRuns(ruleId),
  });
  if (runs.isPending) return <p className="muted">Abrindo o registro…</p>;
  if (runs.isError) return <Notice tone="error">{describeError(runs.error)}</Notice>;
  if (runs.data.length === 0) {
    return <p className="muted">A regra ainda não agiu. Os últimos 90 dias ficam guardados.</p>;
  }
  return (
    <ol className="rule-runs" aria-label="Registro da regra">
      {runs.data.map((run) => {
        const reason = runReason(run);
        return (
          <li key={run.id} className={`run run-${run.outcome}`}>
            <span className="run-outcome">{OUTCOME_NAMES[run.outcome]}</span>
            <span>{run.itemTitle ?? 'um item que você não vê ou que foi removido'}</span>
            <span className="muted">{formatWhen(run.at)}</span>
            {reason === null ? null : <span className="run-reason">{reason}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function RuleForm({
  title,
  initial,
  stages,
  fields,
  people,
  onSave,
  onCancel,
}: {
  title: string;
  initial?: Automation;
  stages: Stage[];
  fields: CustomField[];
  people: RuleAudience[];
  onSave: (input: AutomationInput) => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? '');
  const [trigger, setTrigger] = useState<TriggerDraft>(
    initial ? triggerDraft(initial.trigger) : { on: 'stage', to: '', from: '' },
  );
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    initial ? initial.conditions.map(conditionDraft) : [],
  );
  const [actions, setActions] = useState<ActionDraft[]>(
    initial ? initial.actions.map(actionDraft) : [{ kind: 'stage', value: '', people: [] }],
  );
  const [problem, setProblem] = useState<string | null>(null);

  const stageChoices = stages.map((stage) => ({ value: stage.id, label: stage.name }));
  const anyStage = [{ value: '', label: 'Qualquer etapa' }, ...stageChoices];
  const fieldsToAsk = askable(fields);

  const save = useAction(
    useCallback(async () => {
      setProblem(null);
      const builtConditions = conditions.map(conditionOf);
      const builtActions = actions.map(actionOf);
      if (name.trim() === '') {
        setProblem('Dê um nome à regra.');
        return;
      }
      if (builtConditions.some((one) => one === undefined)) {
        setProblem('Complete ou tire as condições sem valor.');
        return;
      }
      if (builtActions.length === 0 || builtActions.some((one) => one === undefined)) {
        setProblem(
          'Complete as ações: cada uma precisa de uma etapa, pessoa, prioridade ou texto.',
        );
        return;
      }
      await onSave({
        name: name.trim(),
        trigger: triggerOf(trigger),
        conditions: builtConditions.flatMap((one) => (one === undefined ? [] : [one])),
        actions: builtActions.flatMap((one) => (one === undefined ? [] : [one])),
      });
    }, [name, trigger, conditions, actions, onSave]),
  );

  const conditionKinds = [
    { value: 'stage', label: 'A etapa é' },
    { value: 'priority', label: 'A prioridade é' },
    { value: 'assignee', label: 'O responsável é' },
    ...fieldsToAsk.map((field) => ({ value: `field:${field.id}`, label: `${field.name} é` })),
  ];
  const valuesFor = (kind: string): { value: string; label: string }[] => {
    if (kind === 'stage') return stageChoices;
    if (kind === 'priority') return PRIORITY_CHOICES;
    if (kind === 'assignee') {
      return [
        { value: 'none', label: 'Ninguém' },
        ...people.map((person) => ({ value: person.id, label: person.name })),
      ];
    }
    const field = fieldsToAsk.find((one) => `field:${one.id}` === kind);
    if (field?.kind === 'checkbox') {
      return [
        { value: 'true', label: 'Marcado' },
        { value: 'false', label: 'Desmarcado' },
      ];
    }
    return (field?.config.options ?? [])
      .filter((option) => option.archived !== true)
      .map((option) => ({ value: option.id, label: option.name }));
  };
  const withEmpty = (choices: { value: string; label: string }[], value: string) =>
    value === '' ? [{ value: '', label: 'Escolha' }, ...choices] : choices;

  return (
    <Form onSubmit={save.run}>
      <div className="rule-form">
        <h3>{title}</h3>
        <Field
          label="Nome da regra"
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <fieldset className="rule-part">
          <legend>Quando</legend>
          <Select
            label="O que faz a regra agir"
            value={trigger.on}
            options={[
              { value: 'stage', label: 'Um item muda de etapa' },
              { value: 'created', label: 'Um item é criado' },
            ]}
            onChange={(on) => {
              setTrigger({ ...trigger, on });
            }}
          />
          {trigger.on === 'stage' ? (
            <div className="rule-row">
              <Select
                label="Entra em"
                value={trigger.to}
                options={anyStage}
                onChange={(to) => {
                  setTrigger({ ...trigger, to });
                }}
              />
              <Select
                label="Vindo de"
                value={trigger.from}
                options={anyStage}
                onChange={(from) => {
                  setTrigger({ ...trigger, from });
                }}
              />
            </div>
          ) : null}
        </fieldset>

        <fieldset className="rule-part">
          <legend>Se (todas valem)</legend>
          {conditions.length === 0 ? (
            <p className="field-note">Sem condições: a regra age em todo item.</p>
          ) : null}
          {conditions.map((condition, index) => (
            <div className="rule-row" key={index}>
              <Select
                label={`Condição ${String(index + 1)}`}
                value={condition.kind}
                options={conditionKinds}
                onChange={(kind) => {
                  setConditions(
                    conditions.map((one, at) => (at === index ? { kind, value: '' } : one)),
                  );
                }}
              />
              <Select
                label={`Valor da condição ${String(index + 1)}`}
                value={condition.value}
                options={withEmpty(valuesFor(condition.kind), condition.value)}
                onChange={(value) => {
                  setConditions(
                    conditions.map((one, at) => (at === index ? { ...one, value } : one)),
                  );
                }}
              />
              <Button
                variant="quiet"
                aria-label={`Tirar a condição ${String(index + 1)}`}
                onClick={() => {
                  setConditions(conditions.filter((_, at) => at !== index));
                }}
              >
                Tirar
              </Button>
            </div>
          ))}
          {conditions.length < MAX_AUTOMATION_CONDITIONS ? (
            <Button
              variant="quiet"
              onClick={() => {
                setConditions([...conditions, { kind: 'priority', value: '' }]);
              }}
            >
              Adicionar condição
            </Button>
          ) : null}
        </fieldset>

        <fieldset className="rule-part">
          <legend>Então, nesta ordem</legend>
          {actions.map((action, index) => (
            <ActionRow
              key={index}
              index={index}
              action={action}
              stageChoices={stageChoices}
              people={people}
              canRemove={actions.length > 1}
              onChange={(next) => {
                setActions(actions.map((one, at) => (at === index ? next : one)));
              }}
              onRemove={() => {
                setActions(actions.filter((_, at) => at !== index));
              }}
              withEmpty={withEmpty}
            />
          ))}
          {actions.length < MAX_AUTOMATION_ACTIONS ? (
            <Button
              variant="quiet"
              onClick={() => {
                setActions([...actions, { kind: 'notify', value: '', people: [] }]);
              }}
            >
              Adicionar ação
            </Button>
          ) : null}
        </fieldset>

        {problem !== null ? <Notice tone="error">{problem}</Notice> : null}
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        <p className="field-note">Ao salvar, a regra passa a agir com o seu acesso.</p>
        <div className="actions">
          <Button type="submit" busy={save.busy}>
            Salvar regra
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </div>
    </Form>
  );
}

function ActionRow({
  index,
  action,
  stageChoices,
  people,
  canRemove,
  onChange,
  onRemove,
  withEmpty,
}: {
  index: number;
  action: ActionDraft;
  stageChoices: { value: string; label: string }[];
  people: RuleAudience[];
  canRemove: boolean;
  onChange: (next: ActionDraft) => void;
  onRemove: () => void;
  withEmpty: (
    choices: { value: string; label: string }[],
    value: string,
  ) => { value: string; label: string }[];
}): ReactNode {
  const textId = useId();
  const number = String(index + 1);
  const valueLabel = `Valor da ação ${number}`;
  let value: ReactNode;
  if (action.kind === 'stage') {
    value = (
      <Select
        label={valueLabel}
        value={action.value}
        options={withEmpty(stageChoices, action.value)}
        onChange={(next) => {
          onChange({ ...action, value: next });
        }}
      />
    );
  } else if (action.kind === 'priority') {
    value = (
      <Select
        label={valueLabel}
        value={action.value}
        options={withEmpty(PRIORITY_CHOICES, action.value)}
        onChange={(next) => {
          onChange({ ...action, value: next });
        }}
      />
    );
  } else if (action.kind === 'assign') {
    value = (
      <Select
        label={valueLabel}
        value={action.value}
        options={withEmpty(
          people
            .filter((person) => person.canWork)
            .map((person) => ({ value: person.id, label: person.name })),
          action.value,
        )}
        onChange={(next) => {
          onChange({ ...action, value: next });
        }}
      />
    );
  } else if (action.kind === 'notify') {
    value = (
      <fieldset className="rule-people">
        <legend>Quem avisar na ação {number}</legend>
        {people.map((person) => {
          const chosen = action.people.includes(person.id);
          return (
            <label key={person.id} className="check">
              <input
                type="checkbox"
                checked={chosen}
                disabled={!chosen && action.people.length >= MAX_AUTOMATION_NOTIFY}
                onChange={() => {
                  onChange({
                    ...action,
                    people: chosen
                      ? action.people.filter((id) => id !== person.id)
                      : [...action.people, person.id],
                  });
                }}
              />
              {person.name}
            </label>
          );
        })}
        <p className="field-note">Só quem vê o item recebe o aviso; quem fez a mudança, não.</p>
      </fieldset>
    );
  } else {
    value = (
      <div className="field">
        <label htmlFor={textId}>Texto do comentário da ação {number}</label>
        <textarea
          id={textId}
          rows={2}
          maxLength={MAX_AUTOMATION_COMMENT}
          value={action.value}
          onChange={(event) => {
            onChange({ ...action, value: event.target.value });
          }}
        />
      </div>
    );
  }
  return (
    <div className="rule-row">
      <Select
        label={`Ação ${number}`}
        value={action.kind}
        options={ACTION_CHOICES}
        onChange={(kind) => {
          onChange({ kind, value: '', people: [] });
        }}
      />
      {value}
      {canRemove ? (
        <Button variant="quiet" aria-label={`Tirar a ação ${number}`} onClick={onRemove}>
          Tirar
        </Button>
      ) : null}
    </div>
  );
}
