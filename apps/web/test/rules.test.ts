import { describe, expect, it } from 'vitest';
import type { RuleAction, RuleCondition } from '../src/api.js';
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
  });

  it('names only the stages chosen in a trigger', () => {
    expect(triggerOf({ on: 'created', to: 'feito', from: '' })).toEqual({ on: 'created' });
    expect(triggerOf({ on: 'stage', to: 'feito', from: '' })).toEqual({ on: 'stage', to: 'feito' });
    expect(triggerOf({ on: 'stage', to: '', from: '' })).toEqual({ on: 'stage' });
    expect(triggerDraft({ on: 'stage', from: 'aberto' })).toEqual({
      on: 'stage',
      to: '',
      from: 'aberto',
    });
    expect(triggerDraft({ on: 'created' })).toEqual({ on: 'created', to: '', from: '' });
  });
});
