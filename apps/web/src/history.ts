import type { FieldValue } from '@cerebro/shared';
import type { ItemChange } from './api.js';
import { showValue, type FieldLike } from './fieldvalues.js';

/*
 * One line of an item's history as a sentence. Pure, so the wording can be
 * tested: what is stored are codes and ids, what people read are names.
 */

export interface HistoryContext {
  /** "você", a person's name, or a neutral word when the name is not known here. */
  nameOf: (userId: string | null) => string;
  fieldOf: (fieldId: string) => FieldLike | undefined;
  listNameOf: (listId: string) => string | undefined;
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const stageName = (value: unknown): string => {
  const name =
    typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : 'outra etapa';
};

export interface ChangeLine {
  sentence: string;
  /** A longer text worth keeping but not worth reading every time: a previous description. */
  before?: string;
}

export function describeChange(change: ItemChange, context: HistoryContext): ChangeLine {
  const who = capitalized(context.nameOf(change.actor));
  switch (change.what) {
    case 'created':
      return { sentence: `${who} criou o item` };
    case 'title':
      return {
        sentence: `${who} mudou o título de “${text(change.old)}” para “${text(change.new)}”`,
      };
    case 'description': {
      const before = text(change.old);
      return before === ''
        ? { sentence: `${who} escreveu a descrição` }
        : { sentence: `${who} alterou a descrição`, before };
    }
    case 'list': {
      const from = context.listNameOf(text(change.old)) ?? 'outra lista';
      const to = context.listNameOf(text(change.new)) ?? 'outra lista';
      return { sentence: `${who} moveu o item de ${from} para ${to}` };
    }
    case 'stage':
      return {
        sentence: `${who} moveu de ${stageName(change.old)} para ${stageName(change.new)}`,
      };
    case 'assigned':
      return change.new === change.actor
        ? { sentence: `${who} ficou com o item` }
        : { sentence: `${who} passou o item para ${context.nameOf(text(change.new))}` };
    case 'unassigned':
      return change.old === change.actor
        ? { sentence: `${who} saiu do item` }
        : { sentence: `${who} tirou ${context.nameOf(text(change.old))} do item` };
    case 'field': {
      const field = change.fieldId === null ? undefined : context.fieldOf(change.fieldId);
      if (!field) return { sentence: `${who} alterou um campo` };
      const show = (value: unknown): string =>
        value === null || value === undefined ? '' : showValue(field, value as FieldValue);
      const [before, after] = [show(change.old), show(change.new)];
      if (change.old === null || change.old === undefined) {
        return { sentence: `${who} preencheu ${field.name}: ${after}` };
      }
      if (change.new === null || change.new === undefined) {
        return { sentence: `${who} limpou ${field.name} (era ${before})` };
      }
      return { sentence: `${who} mudou ${field.name} de ${before} para ${after}` };
    }
  }
}
