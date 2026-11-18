import type { FieldValue } from '@cerebro/shared';
import type { ItemChange } from './api.js';
import { fullDay, priorityLabel } from './due.js';
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
  /** The title of an item this person can see, by id; undefined when they cannot. */
  itemTitleOf?: (itemId: string) => string | undefined;
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const fileName = (value: unknown): string => {
  const name =
    typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? `“${name}”` : 'um arquivo';
};
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
    case 'trashed':
      return { sentence: `${who} mandou o item para a lixeira` };
    case 'restored':
      return { sentence: `${who} tirou o item da lixeira` };
    case 'attachment_added':
      return { sentence: `${who} anexou ${fileName(change.new)}` };
    case 'attachment_removed':
      return { sentence: `${who} mandou o anexo ${fileName(change.new)} para a lixeira` };
    case 'attachment_restored':
      return { sentence: `${who} tirou o anexo ${fileName(change.new)} da lixeira` };
    case 'priority': {
      const after = typeof change.new === 'number' ? priorityLabel(change.new) : null;
      const before = typeof change.old === 'number' ? priorityLabel(change.old) : null;
      if (after === null) return { sentence: `${who} tirou a prioridade (era ${before ?? '?'})` };
      return before === null
        ? { sentence: `${who} definiu a prioridade: ${after}` }
        : { sentence: `${who} mudou a prioridade de ${before} para ${after}` };
    }
    case 'start_date':
    case 'due_date': {
      const name = change.what === 'due_date' ? 'o prazo' : 'o começo';
      const after = typeof change.new === 'string' ? fullDay(change.new) : null;
      const before = typeof change.old === 'string' ? fullDay(change.old) : null;
      if (after === null) return { sentence: `${who} tirou ${name} (era ${before ?? '?'})` };
      return before === null
        ? { sentence: `${who} marcou ${name} para ${after}` }
        : { sentence: `${who} mudou ${name} de ${before} para ${after}` };
    }
    case 'parent': {
      const named = (value: unknown): string => {
        const title = typeof value === 'string' ? context.itemTitleOf?.(value) : undefined;
        return title === undefined ? 'outro item' : `“${title}”`;
      };
      if (change.new === null || change.new === undefined) {
        return { sentence: `${who} tirou o item de dentro de ${named(change.old)}` };
      }
      return change.old === null || change.old === undefined
        ? { sentence: `${who} fez do item uma subtarefa de ${named(change.new)}` }
        : { sentence: `${who} passou o item para dentro de ${named(change.new)}` };
    }
    case 'field': {
      const field = change.fieldId === null ? undefined : context.fieldOf(change.fieldId);
      if (!field) return { sentence: `${who} alterou um campo` };
      // A secret is never written down, not even here: only that it changed.
      if (field.kind === 'secret') {
        if (change.old === null || change.old === undefined) {
          return { sentence: `${who} guardou um valor em ${field.name}` };
        }
        if (change.new === null || change.new === undefined) {
          return { sentence: `${who} apagou o valor de ${field.name}` };
        }
        return { sentence: `${who} trocou o valor de ${field.name}` };
      }
      const show = (value: unknown): string =>
        value === null || value === undefined
          ? ''
          : showValue(field, value as FieldValue, context.nameOf);
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
