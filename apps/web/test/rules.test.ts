import { describe, expect, it } from 'vitest';
import type { RuleAction, RuleCondition, RuleTrigger } from '../src/api.js';
import {
  actionDraft,
  actionOf,
  conditionDraft,
  conditionOf,
  joined,
  ruleSentence,
  runReason,
  triggerDraft,
  triggerOf,
  type RuleContext,
} from '../src/rules.js';

const context: RuleContext = {
  stageName: (id) => ({ aberto: 'Aberto', feito: 'Feito' })[id],
  personName: (id) => ({ ana: 'Ana', bruno: 'Bruno', marta: 'Marta' })[id],
  fieldName: (id) =>
    id === 'fornecedor' ? 'Fornecedor' : id === 'conferido' ? 'Conferido' : undefined,
  optionName: (field, option) => (field === 'fornecedor' && option === 'alfa' ? 'Alfa' : undefined),
};

describe('a rule as a sentence', () => {
  it('says when, if and then, with names', () => {
    expect(
      ruleSentence(
        {
          trigger: { on: 'stage', from: 'aberto', to: 'feito' },
          conditions: [
            { if: 'priority', is: 1 },
            { if: 'field', field: 'fornecedor', is: 'alfa' },
            { if: 'field', field: 'conferido', is: false },
          ],
          actions: [
            { do: 'assign', to: 'ana' },
            { do: 'notify', to: ['bruno', 'marta', 'sumiu'] },
            { do: 'priority', to: null },
          ],
        },
        context,
      ),
    ).toBe(
      'Quando um item sai de Aberto e entra em Feito, se a prioridade é Urgente, Fornecedor é Alfa ' +
        'e Conferido não está marcado: passar para Ana, avisar Bruno, Marta e alguém sem acesso ' +
        'e tirar a prioridade.',
    );
    expect(
      ruleSentence(
        {
          trigger: { on: 'created' },
          conditions: [{ if: 'assignee', is: null }],
          actions: [{ do: 'comment', text: 'x'.repeat(80) }],
        },
        context,
      ),
    ).toBe(`Quando um item é criado, se ninguém é responsável: comentar “${'x'.repeat(59)}…”.`);
    expect(
      ruleSentence(
        { trigger: { on: 'stage' }, conditions: [], actions: [{ do: 'stage', to: 'velha' }] },
        context,
      ),
    ).toBe('Quando um item muda de etapa: mover para uma etapa apagada.');
    expect(
      ruleSentence(
        {
          trigger: { on: 'stage', from: 'feito' },
          conditions: [
            { if: 'stage', is: 'aberto' },
            { if: 'assignee', is: 'ana' },
            { if: 'priority', is: null },
            { if: 'field', field: 'velho', is: true },
          ],
          actions: [{ do: 'priority', to: 4 }],
        },
        context,
      ),
    ).toBe(
      'Quando um item sai de Feito, se a etapa é Aberto, Ana é responsável, o item não tem ' +
        'prioridade e um campo arquivado está marcado: mudar a prioridade para Baixa.',
    );
    expect(
      ruleSentence({ trigger: { on: 'stage', to: 'feito' }, conditions: [], actions: [] }, context),
    ).toBe('Quando um item entra em Feito: .');
    expect(joined([])).toBe('');
  });

  it('says why a run did not act', () => {
    expect(runReason({ outcome: 'done', detail: null })).toBeNull();
    expect(runReason({ outcome: 'skipped', detail: 'no_access' })).toContain(
      'não pode mais editar',
    );
    expect(runReason({ outcome: 'failed', detail: 'CB001' })).toContain('não tem permissão');
    expect(runReason({ outcome: 'failed', detail: 'CB003' })).toContain('não é mais possível');
    expect(runReason({ outcome: 'failed', detail: '40P01' })).toBe('erro 40P01; nada foi mudado');
  });
});

describe('what the rule form edits', () => {
  it('turns every condition into a draft and back', () => {
    const all: RuleCondition[] = [
      { if: 'stage', is: 'aberto' },
      { if: 'priority', is: 2 },
      { if: 'priority', is: null },
      { if: 'assignee', is: 'ana' },
      { if: 'assignee', is: null },
      { if: 'field', field: 'fornecedor', is: 'alfa' },
      { if: 'field', field: 'conferido', is: true },
      { if: 'field', field: 'conferido', is: false },
    ];
    for (const condition of all) expect(conditionOf(conditionDraft(condition))).toEqual(condition);
    expect(conditionOf({ kind: 'stage', value: '' })).toBeUndefined();
    expect(conditionOf({ kind: 'priority', value: '7' })).toBeUndefined();
    expect(conditionOf({ kind: 'title', value: 'x' })).toBeUndefined();
  });

  it('turns every action into a draft and back, and refuses what is incomplete', () => {
    const all: RuleAction[] = [
      { do: 'stage', to: 'feito' },
      { do: 'priority', to: 3 },
      { do: 'priority', to: null },
      { do: 'assign', to: 'ana' },
      { do: 'notify', to: ['ana', 'bruno'] },
      { do: 'comment', text: 'Olhe isto.' },
      { do: 'field', field: 'fornecedor', value: 'alfa' },
      { do: 'field', field: 'conferido', value: null },
      { do: 'due', in: 0 },
      { do: 'due', in: 30 },
      { do: 'due', in: null },
      { do: 'subtask', title: 'Conferir' },
    ];
    for (const action of all) expect(actionOf(actionDraft(action))).toEqual(action);
    expect(actionOf({ kind: 'notify', value: '', people: [] })).toBeUndefined();
    expect(actionOf({ kind: 'comment', value: '   ', people: [] })).toBeUndefined();
    expect(actionOf({ kind: 'comment', value: ' Oi ', people: [] })).toEqual({
      do: 'comment',
      text: 'Oi',
    });
    expect(actionOf({ kind: 'assign', value: '', people: [] })).toBeUndefined();
    expect(actionOf({ kind: 'stage', value: '', people: [] })).toBeUndefined();
    expect(actionOf({ kind: 'priority', value: '', people: [] })).toBeUndefined();
    // A field not chosen, or a value that does not fit it yet.
    expect(actionOf({ kind: 'field', value: '', people: [], field: '' })).toBeUndefined();
    expect(
      actionOf({ kind: 'field', value: '', people: [], field: 'valor', fieldValue: undefined }),
    ).toBeUndefined();
    for (const days of ['', '-1', '366', '1.5', 'x']) {
      expect(actionOf({ kind: 'due', value: days, people: [] }), days).toBeUndefined();
    }
    expect(actionOf({ kind: 'subtask', value: '  Revisar  ', people: [] })).toEqual({
      do: 'subtask',
      title: 'Revisar',
    });
    expect(actionOf({ kind: 'subtask', value: ' ', people: [] })).toBeUndefined();
  });

  it('turns every trigger into a draft and back, and refuses one without its field', () => {
    const none = { to: '', from: '', field: '', is: '' };
    expect(triggerOf({ ...none, on: 'created', to: 'feito' })).toEqual({ on: 'created' });
    expect(triggerOf({ ...none, on: 'stage', to: 'feito' })).toEqual({ on: 'stage', to: 'feito' });
    expect(triggerOf({ ...none, on: 'stage' })).toEqual({ on: 'stage' });
    expect(triggerOf({ ...none, on: 'field' })).toBeUndefined();
    expect(triggerOf({ ...none, on: 'assigned' })).toEqual({ on: 'assigned' });
    const all: RuleTrigger[] = [
      { on: 'created' },
      { on: 'stage', from: 'aberto' },
      { on: 'stage', to: 'feito', from: 'aberto' },
      { on: 'field', field: 'fornecedor' },
      { on: 'field', field: 'fornecedor', is: 'alfa' },
      { on: 'field', field: 'conferido', is: true },
      { on: 'field', field: 'conferido', is: false },
      { on: 'assigned' },
      { on: 'assigned', to: 'ana' },
    ];
    for (const trigger of all) expect(triggerOf(triggerDraft(trigger))).toEqual(trigger);
  });
});

describe('the newer rules as sentences', () => {
  const withValues: RuleContext = {
    ...context,
    valueText: (field, value) => (field === 'nota' ? String(value) : undefined),
    fieldName: (id) => ({ fornecedor: 'Fornecedor', conferido: 'Conferido', nota: 'Nota' })[id],
  };
  it('says which field or person sets a rule off, and what it fills in', () => {
    const say = (trigger: RuleTrigger, actions: RuleAction[]): string =>
      ruleSentence({ trigger, conditions: [], actions }, withValues);
    expect(say({ on: 'field', field: 'fornecedor' }, [{ do: 'due', in: 0 }])).toBe(
      'Quando Fornecedor muda: pôr o prazo para hoje.',
    );
    expect(say({ on: 'field', field: 'fornecedor', is: 'alfa' }, [{ do: 'due', in: 1 }])).toBe(
      'Quando Fornecedor passa a ser Alfa: pôr o prazo para amanhã.',
    );
    expect(say({ on: 'field', field: 'fornecedor', is: 'sumiu' }, [{ do: 'due', in: 3 }])).toBe(
      'Quando Fornecedor passa a ser uma opção arquivada: pôr o prazo para daqui a 3 dias.',
    );
    expect(say({ on: 'field', field: 'conferido', is: true }, [{ do: 'due', in: null }])).toBe(
      'Quando Conferido é marcado: tirar o prazo.',
    );
    expect(
      say({ on: 'field', field: 'conferido', is: false }, [
        { do: 'field', field: 'conferido', value: true },
      ]),
    ).toBe('Quando Conferido é desmarcado: marcar Conferido.');
    expect(
      say({ on: 'assigned' }, [
        { do: 'field', field: 'nota', value: 'Ver contrato' },
        { do: 'field', field: 'fornecedor', value: null },
        { do: 'field', field: 'fornecedor', value: 'alfa' },
      ]),
    ).toBe(
      'Quando alguém recebe um item: preencher Nota com “Ver contrato”, limpar Fornecedor e ' +
        'preencher Fornecedor.',
    );
    expect(say({ on: 'assigned', to: 'ana' }, [{ do: 'subtask', title: 'Ligar' }])).toBe(
      'Quando Ana recebe um item: criar a subtarefa “Ligar”.',
    );
    expect(say({ on: 'field', field: 'velho' }, [{ do: 'due', in: 2 }])).toBe(
      'Quando um campo arquivado muda: pôr o prazo para daqui a 2 dias.',
    );
  });
});
