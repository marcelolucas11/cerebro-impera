import type { FieldValue } from '@cerebro/shared';
import type { AutomationRun, RuleAction, RuleCondition, RuleTrigger, RunOutcome } from './api.js';
import { PRIORITY_NAMES } from './due.js';

/*
 * Rules of a list read as sentences, and the drafts the rule form edits. Pure,
 * so the wording and the conversions can be tested: what is stored are ids,
 * what people read are names.
 */

export interface RuleContext {
  stageName: (id: string) => string | undefined;
  personName: (id: string) => string | undefined;
  fieldName: (id: string) => string | undefined;
  optionName: (fieldId: string, optionId: string) => string | undefined;
  /** A value of a field as people read it; undefined when the field is not known here. */
  valueText?: (fieldId: string, value: FieldValue) => string | undefined;
}

/** "A", "A e B", "A, B e C". */
export function joined(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1] ?? ''}`;
}

const stage = (id: string, context: RuleContext): string =>
  context.stageName(id) ?? 'uma etapa apagada';
const person = (id: string, context: RuleContext): string =>
  context.personName(id) ?? 'alguém sem acesso';
const priority = (value: number | null): string =>
  value === null ? '' : (PRIORITY_NAMES[value] ?? String(value));

const fieldName = (id: string, context: RuleContext): string =>
  context.fieldName(id) ?? 'um campo arquivado';

/** "Quando Conferido é marcado", "Quando Fornecedor passa a ser Alfa", "Quando Fornecedor muda". */
function fieldTriggerText(
  field: string,
  is: string | boolean | undefined,
  context: RuleContext,
): string {
  const name = fieldName(field, context);
  if (is === undefined) return `Quando ${name} muda`;
  if (typeof is === 'boolean') return `Quando ${name} é ${is ? 'marcado' : 'desmarcado'}`;
  return `Quando ${name} passa a ser ${context.optionName(field, is) ?? 'uma opção arquivada'}`;
}

export function triggerText(trigger: RuleTrigger, context: RuleContext): string {
  if (trigger.on === 'created') return 'Quando um item é criado';
  if (trigger.on === 'field') return fieldTriggerText(trigger.field, trigger.is, context);
  if (trigger.on === 'due') return dueTriggerText(trigger.offset);
  if (trigger.on === 'assigned') {
    return trigger.to === undefined
      ? 'Quando alguém recebe um item'
      : `Quando ${person(trigger.to, context)} recebe um item`;
  }
  const { to, from } = trigger;
  if (to !== undefined && from !== undefined) {
    return `Quando um item sai de ${stage(from, context)} e entra em ${stage(to, context)}`;
  }
  if (to !== undefined) return `Quando um item entra em ${stage(to, context)}`;
  if (from !== undefined) return `Quando um item sai de ${stage(from, context)}`;
  return 'Quando um item muda de etapa';
}

export function conditionText(condition: RuleCondition, context: RuleContext): string {
  switch (condition.if) {
    case 'stage':
      return `a etapa é ${stage(condition.is, context)}`;
    case 'priority':
      return condition.is === null
        ? 'o item não tem prioridade'
        : `a prioridade é ${priority(condition.is)}`;
    case 'assignee':
      return condition.is === null
        ? 'ninguém é responsável'
        : `${person(condition.is, context)} é responsável`;
    case 'field': {
      const name = context.fieldName(condition.field) ?? 'um campo arquivado';
      if (typeof condition.is === 'boolean') {
        return condition.is ? `${name} está marcado` : `${name} não está marcado`;
      }
      return `${name} é ${context.optionName(condition.field, condition.is) ?? 'uma opção arquivada'}`;
    }
  }
}

const quoted = (text: string): string =>
  `“${text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text}”`;

export function actionText(action: RuleAction, context: RuleContext): string {
  switch (action.do) {
    case 'stage':
      return `mover para ${stage(action.to, context)}`;
    case 'priority':
      return action.to === null
        ? 'tirar a prioridade'
        : `mudar a prioridade para ${priority(action.to)}`;
    case 'assign':
      return `passar para ${person(action.to, context)}`;
    case 'notify':
      return `avisar ${joined(action.to.map((id) => person(id, context)))}`;
    case 'comment':
      return `comentar ${quoted(action.text)}`;
    case 'field': {
      const name = fieldName(action.field, context);
      if (action.value === null) return `limpar ${name}`;
      if (action.value === true) return `marcar ${name}`;
      const shown = context.valueText?.(action.field, action.value);
      return shown === undefined || shown === ''
        ? `preencher ${name}`
        : `preencher ${name} com ${quoted(shown)}`;
    }
    case 'due':
      return action.in === null ? 'tirar o prazo' : `pôr o prazo para ${daysAhead(action.in)}`;
    case 'subtask':
      return `criar a subtarefa ${quoted(action.title)}`;
  }
}

/** "Quando faltam 2 dias para o prazo", "Quando o prazo chega", "Quando o item está 1 dia atrasado". */
export function dueTriggerText(offset: number): string {
  if (offset === 0) return 'Quando o prazo chega';
  const days = Math.abs(offset);
  const count = days === 1 ? '1 dia' : `${String(days)} dias`;
  return offset < 0
    ? `Quando ${days === 1 ? 'falta' : 'faltam'} ${count} para o prazo`
    : `Quando o item está ${count} atrasado`;
}

/** "hoje", "amanhã", "daqui a 3 dias". */
export function daysAhead(days: number): string {
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  return `daqui a ${String(days)} dias`;
}

export function ruleSentence(
  rule: { trigger: RuleTrigger; conditions: RuleCondition[]; actions: RuleAction[] },
  context: RuleContext,
): string {
  const when = triggerText(rule.trigger, context);
  const conditions = rule.conditions.map((condition) => conditionText(condition, context));
  const actions = rule.actions.map((action) => actionText(action, context));
  const fits = conditions.length === 0 ? '' : `, se ${joined(conditions)}`;
  return `${when}${fits}: ${joined(actions)}.`;
}

export const OUTCOME_NAMES: Record<RunOutcome, string> = {
  done: 'Agiu',
  skipped: 'Não agiu',
  failed: 'Falhou',
};

/** Why a run did not act, in words; the codes come from the database. */
export function runReason(run: Pick<AutomationRun, 'outcome' | 'detail'>): string | null {
  if (run.outcome === 'done') return null;
  if (run.outcome === 'skipped') {
    return 'quem salvou a regra por último não pode mais editar este item';
  }
  switch (run.detail) {
    case 'CB001':
      return 'quem salvou a regra por último não tem permissão para uma das ações; nada foi mudado';
    case 'CB003':
      return 'uma das ações não é mais possível (uma pessoa sem acesso, por exemplo); nada foi mudado';
    default:
      return `erro ${run.detail ?? 'desconhecido'}; nada foi mudado`;
  }
}

// ---------------------------------------------------------------------------
// Drafts: what the form edits, one select and one value per line
// ---------------------------------------------------------------------------

/** `kind` is 'stage', 'priority', 'assignee' or `field:<id>`; `value` an id, a number, 'none', 'true' or 'false'. */
export interface ConditionDraft {
  kind: string;
  value: string;
}
export type ActionKind = RuleAction['do'];
/**
 * `value`: a stage, a priority, a person, a text, a number of days or 'none'.
 * For a field: `field` is the field, and `fieldValue` what to put in it (null
 * clears it; undefined while what was typed does not fit the field).
 */
export interface ActionDraft {
  kind: ActionKind;
  value: string;
  people: string[];
  field?: string;
  fieldValue?: FieldValue | null | undefined;
}

const NONE = 'none';
const asPriority = (value: string): 1 | 2 | 3 | 4 | null | undefined => {
  if (value === NONE) return null;
  const number = Number(value);
  return number === 1 || number === 2 || number === 3 || number === 4 ? number : undefined;
};

/** The condition a draft stands for; undefined while it is incomplete. */
export function conditionOf(draft: ConditionDraft): RuleCondition | undefined {
  if (draft.value === '') return undefined;
  if (draft.kind === 'stage') return { if: 'stage', is: draft.value };
  if (draft.kind === 'priority') {
    const is = asPriority(draft.value);
    return is === undefined ? undefined : { if: 'priority', is };
  }
  if (draft.kind === 'assignee') {
    return { if: 'assignee', is: draft.value === NONE ? null : draft.value };
  }
  if (draft.kind.startsWith('field:')) {
    const field = draft.kind.slice('field:'.length);
    if (draft.value === 'true' || draft.value === 'false') {
      return { if: 'field', field, is: draft.value === 'true' };
    }
    return { if: 'field', field, is: draft.value };
  }
  return undefined;
}

export function conditionDraft(condition: RuleCondition): ConditionDraft {
  switch (condition.if) {
    case 'stage':
      return { kind: 'stage', value: condition.is };
    case 'priority':
      return { kind: 'priority', value: condition.is === null ? NONE : String(condition.is) };
    case 'assignee':
      return { kind: 'assignee', value: condition.is ?? NONE };
    case 'field':
      return { kind: `field:${condition.field}`, value: String(condition.is) };
  }
}

/** The action a draft stands for; undefined while it is incomplete. */
export function actionOf(draft: ActionDraft): RuleAction | undefined {
  switch (draft.kind) {
    case 'stage':
      return draft.value === '' ? undefined : { do: 'stage', to: draft.value };
    case 'priority': {
      const to = asPriority(draft.value);
      return to === undefined ? undefined : { do: 'priority', to };
    }
    case 'assign':
      return draft.value === '' ? undefined : { do: 'assign', to: draft.value };
    case 'notify':
      return draft.people.length === 0 ? undefined : { do: 'notify', to: [...draft.people] };
    case 'comment':
      return draft.value.trim() === '' ? undefined : { do: 'comment', text: draft.value.trim() };
    case 'field':
      return draft.field === undefined || draft.field === '' || draft.fieldValue === undefined
        ? undefined
        : { do: 'field', field: draft.field, value: draft.fieldValue };
    case 'due': {
      if (draft.value === NONE) return { do: 'due', in: null };
      const days = Number(draft.value);
      return draft.value !== '' && Number.isInteger(days) && days >= 0 && days <= 365
        ? { do: 'due', in: days }
        : undefined;
    }
    case 'subtask':
      return draft.value.trim() === '' ? undefined : { do: 'subtask', title: draft.value.trim() };
  }
}

export function actionDraft(action: RuleAction): ActionDraft {
  switch (action.do) {
    case 'stage':
    case 'assign':
      return { kind: action.do, value: action.to, people: [] };
    case 'priority':
      return { kind: 'priority', value: action.to === null ? NONE : String(action.to), people: [] };
    case 'notify':
      return { kind: 'notify', value: '', people: [...action.to] };
    case 'comment':
      return { kind: 'comment', value: action.text, people: [] };
    case 'field':
      return {
        kind: 'field',
        value: '',
        people: [],
        field: action.field,
        fieldValue: action.value,
      };
    case 'due':
      return { kind: 'due', value: action.in === null ? NONE : String(action.in), people: [] };
    case 'subtask':
      return { kind: 'subtask', value: action.title, people: [] };
  }
}

/**
 * The trigger as the form edits it ('' for any): the stages it names; the
 * field and the value it changes to ('true'/'false' for a checkbox); the
 * person handed the item, kept in `to`; or the days from the due date, in `is`.
 */
export interface TriggerDraft {
  on: RuleTrigger['on'];
  to: string;
  from: string;
  field: string;
  is: string;
}

/** The trigger a draft stands for; undefined while it is incomplete. */
export function triggerOf(draft: TriggerDraft): RuleTrigger | undefined {
  switch (draft.on) {
    case 'created':
      return { on: 'created' };
    case 'stage':
      return {
        on: 'stage',
        ...(draft.to === '' ? {} : { to: draft.to }),
        ...(draft.from === '' ? {} : { from: draft.from }),
      };
    case 'field': {
      if (draft.field === '') return undefined;
      if (draft.is === '') return { on: 'field', field: draft.field };
      const is = draft.is === 'true' ? true : draft.is === 'false' ? false : draft.is;
      return { on: 'field', field: draft.field, is };
    }
    case 'assigned':
      return draft.to === '' ? { on: 'assigned' } : { on: 'assigned', to: draft.to };
    case 'due': {
      const offset = Number(draft.is);
      return draft.is !== '' && Number.isInteger(offset) && Math.abs(offset) <= 30
        ? { on: 'due', offset }
        : undefined;
    }
  }
}

export function triggerDraft(trigger: RuleTrigger): TriggerDraft {
  const empty = { to: '', from: '', field: '', is: '' };
  switch (trigger.on) {
    case 'created':
      return { ...empty, on: 'created' };
    case 'stage':
      return { ...empty, on: 'stage', to: trigger.to ?? '', from: trigger.from ?? '' };
    case 'field':
      return {
        ...empty,
        on: 'field',
        field: trigger.field,
        is: trigger.is === undefined ? '' : String(trigger.is),
      };
    case 'assigned':
      return { ...empty, on: 'assigned', to: trigger.to ?? '' };
    case 'due':
      return { ...empty, on: 'due', is: String(trigger.offset) };
  }
}
