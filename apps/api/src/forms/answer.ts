import {
  fieldValueProblem,
  MAX_FORM_DESCRIPTION,
  MAX_FORM_TITLE,
  parseDecimal,
  type FieldConfig,
  type FieldValueProblem,
  type PublicForm,
} from '@cerebro/shared';

/*
 * What someone typed into a form, read field by field into the values the
 * list stores, or a sentence for each answer that needs fixing. Only the
 * questions the form asks are read; anything else in the request is ignored.
 */

export type FormBody = Record<string, string>;

export interface ReadAnswer {
  title: string;
  description: string | null;
  values: Record<string, string | number | boolean>;
}

export type Answer =
  { ok: true; answer: ReadAnswer } | { ok: false; errors: Record<string, string> };

/** How much each kind of question takes, here: less than the app, since strangers write it. */
export const ANSWER_LIMITS: Record<string, number> = {
  text: 500,
  long_text: MAX_FORM_DESCRIPTION,
  url: 2000,
  email: 320,
  phone: 40,
};

const REQUIRED = 'Responda esta pergunta.';

const PROBLEMS: Partial<Record<FieldValueProblem, string>> = {
  empty: REQUIRED,
  too_long: 'Resposta longa demais. Encurte e envie de novo.',
  invalid_url: 'Escreva o endereço completo, começando com https://',
  invalid_email: 'Escreva um e-mail, como nome@exemplo.com.br',
  invalid_phone: 'Escreva o telefone só com números, espaços, parênteses ou traços.',
  invalid_date: 'Escolha uma data que exista.',
  out_of_range: 'Número grande demais.',
  not_whole: 'Use no máximo dois dígitos depois da vírgula.',
  unknown_option: 'Escolha uma das opções.',
  wrong_type: 'Esta resposta não serve aqui.',
};

/** The name of a question in the page and in what is sent back. */
export const fieldName = (id: string): string => `f_${id}`;

export function readAnswer(form: PublicForm, body: FormBody): Answer {
  const errors: Record<string, string> = {};
  const title = (body.title ?? '').trim();
  if (title === '') errors.title = REQUIRED;
  else if (title.length > MAX_FORM_TITLE)
    errors.title = `Use no máximo ${String(MAX_FORM_TITLE)} caracteres.`;

  let description: string | null = null;
  if (form.descriptionLabel !== null) {
    const text = (body.description ?? '').trim();
    if (text.length > MAX_FORM_DESCRIPTION) {
      errors.description = `Use no máximo ${String(MAX_FORM_DESCRIPTION)} caracteres.`;
    } else if (text !== '') {
      description = text;
    }
  }

  const values: ReadAnswer['values'] = {};
  for (const field of form.fields) {
    const name = fieldName(field.id);
    const raw = (body[name] ?? '').trim();
    let value: string | number | boolean | null;
    if (field.kind === 'checkbox') {
      value = raw === 'sim' ? true : null;
      if (value === null && field.required) {
        errors[name] = 'Marque para enviar.';
        continue;
      }
    } else if (raw === '') {
      value = null;
      if (field.required) {
        errors[name] = REQUIRED;
        continue;
      }
    } else if (field.kind === 'number' || field.kind === 'money') {
      const parsed = parseDecimal(raw);
      if (parsed === null) {
        errors[name] = 'Escreva um número, como 1.250,50';
        continue;
      }
      if (field.kind === 'money') {
        const cents = Math.round(parsed * 100);
        if (Math.abs(parsed * 100 - cents) > 1e-6) {
          errors[name] = PROBLEMS.not_whole ?? REQUIRED;
          continue;
        }
        value = cents;
      } else {
        value = parsed;
      }
    } else {
      const limit = ANSWER_LIMITS[field.kind];
      if (limit !== undefined && raw.length > limit) {
        errors[name] = `Use no máximo ${String(limit)} caracteres.`;
        continue;
      }
      value = raw;
    }
    if (value === null) continue;
    const config: FieldConfig = {
      options: (field.options ?? []).map((option) => ({ ...option, color: '#9ba6b8' })),
    };
    const problem = fieldValueProblem(field.kind, config, value);
    if (problem !== null) {
      errors[name] = PROBLEMS[problem] ?? PROBLEMS.wrong_type ?? REQUIRED;
      continue;
    }
    values[field.id] = value;
  }

  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, answer: { title, description, values } };
}
