import type { PublicForm } from '@cerebro/shared';
import { ANSWER_LIMITS, fieldName, type FormBody } from './answer.js';

/*
 * The pages of the forms service, written out on the server. No script at
 * all: the page is a plain form the browser sends by itself, so nothing on it
 * can run, and every text in it is escaped, whoever wrote it.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CURRENCY_SIGNS: Record<string, string> = { BRL: 'R$', USD: 'US$', EUR: '€' };

function shell(title: string, brand: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/form.css">
    <link rel="stylesheet" href="/brand.css">
  </head>
  <body>
    <main class="sheet">
      <p class="brand">${escapeHtml(brand)}</p>
${body}
    </main>
  </body>
</html>
`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => `      <p class="intro">${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
    .join('\n');
}

interface Question {
  name: string;
  label: string;
  required: boolean;
  control: (attributes: string) => string;
}

function question(q: Question, errors: Record<string, string>): string {
  const id = `q-${q.name}`;
  const error = errors[q.name];
  const describedBy =
    error === undefined ? '' : ` aria-describedby="${id}-erro" aria-invalid="true"`;
  const attributes = `id="${id}" name="${escapeHtml(q.name)}"${q.required ? ' required' : ''}${describedBy}`;
  return `        <div class="question">
          <label for="${id}">${escapeHtml(q.label)}${q.required ? '' : ' <span class="optional">(opcional)</span>'}</label>
          ${q.control(attributes)}
          ${error === undefined ? '' : `<p class="error" id="${id}-erro">${escapeHtml(error)}</p>`}
        </div>`;
}

export function formPage(input: {
  slug: string;
  brand: string;
  form: PublicForm;
  stamp: string;
  values?: FormBody;
  errors?: Record<string, string>;
  notice?: string;
}): string {
  const { form, slug } = input;
  const values = input.values ?? {};
  const errors = input.errors ?? {};
  const kept = (name: string): string => escapeHtml(values[name] ?? '');
  const text =
    (type: string, name: string, limit: number, extra = ''): Question['control'] =>
    (attributes) =>
      `<input type="${type}" ${attributes} maxlength="${String(limit)}" value="${kept(name)}"${extra}>`;

  const questions: string[] = [
    question(
      {
        name: 'title',
        label: form.titleLabel,
        required: true,
        control: text('text', 'title', 500),
      },
      errors,
    ),
  ];
  if (form.descriptionLabel !== null) {
    questions.push(
      question(
        {
          name: 'description',
          label: form.descriptionLabel,
          required: false,
          control: (attributes) =>
            `<textarea ${attributes} rows="5" maxlength="5000">${kept('description')}</textarea>`,
        },
        errors,
      ),
    );
  }
  for (const field of form.fields) {
    const name = fieldName(field.id);
    const limit = ANSWER_LIMITS[field.kind] ?? 500;
    let control: Question['control'];
    switch (field.kind) {
      case 'long_text':
        control = (attributes) =>
          `<textarea ${attributes} rows="5" maxlength="${String(limit)}">${kept(name)}</textarea>`;
        break;
      case 'number':
        control = text('text', name, 40, ' inputmode="decimal"');
        break;
      case 'money': {
        const sign = CURRENCY_SIGNS[field.currency ?? 'BRL'] ?? field.currency ?? '';
        control = (attributes) =>
          `<span class="money"><span aria-hidden="true">${escapeHtml(sign)}</span><input type="text" ${attributes} maxlength="40" inputmode="decimal" value="${kept(name)}"></span>`;
        break;
      }
      case 'date':
        control = text('date', name, 10);
        break;
      case 'url':
        control = text('url', name, limit, ' placeholder="https://"');
        break;
      case 'email':
        control = text('email', name, limit, ' autocomplete="email"');
        break;
      case 'phone':
        control = text('tel', name, limit, ' autocomplete="tel"');
        break;
      case 'select':
        control = (attributes) => {
          const chosen = values[name] ?? '';
          const options = (field.options ?? [])
            .map(
              (option) =>
                `<option value="${escapeHtml(option.id)}"${option.id === chosen ? ' selected' : ''}>${escapeHtml(option.name)}</option>`,
            )
            .join('');
          return `<select ${attributes}><option value="">Escolha</option>${options}</select>`;
        };
        break;
      case 'checkbox':
        control = (attributes) =>
          `<span class="tick"><input type="checkbox" ${attributes} value="sim"${values[name] === 'sim' ? ' checked' : ''}><span>Sim</span></span>`;
        break;
      default:
        control = text('text', name, limit);
    }
    questions.push(
      question({ name, label: field.name, required: field.required, control }, errors),
    );
  }

  const hasErrors = Object.keys(errors).length > 0;
  const body = `      <h1>${escapeHtml(form.title)}</h1>
${paragraphs(form.intro)}
${hasErrors ? '      <p class="summary" role="alert">Confira as respostas marcadas e envie de novo.</p>' : ''}
${input.notice === undefined ? '' : `      <p class="summary" role="alert">${escapeHtml(input.notice)}</p>`}
      <form method="post" action="/f/${escapeHtml(slug)}">
        <input type="hidden" name="_stamp" value="${escapeHtml(input.stamp)}">
        <div class="trap" aria-hidden="true">
          <label for="q-site">Deixe este campo em branco</label>
          <input type="text" id="q-site" name="_site" tabindex="-1" autocomplete="off">
        </div>
${questions.join('\n')}
        <button type="submit">Enviar</button>
      </form>
      <p class="foot">O que você enviar aqui chega para ${escapeHtml(input.brand)}. Não envie senhas nem dados de cartão.</p>`;
  return shell(form.title, input.brand, body);
}

export function sentPage(brand: string, title: string | null): string {
  return shell(
    'Enviado',
    brand,
    `      <h1>Recebido, obrigado.</h1>
      <p class="intro">${title === null ? 'Sua resposta chegou.' : `Sua resposta a “${escapeHtml(title)}” chegou.`} Pode fechar esta página.</p>`,
  );
}

export function closedPage(brand: string): string {
  return shell(
    'Formulário fechado',
    brand,
    `      <h1>Este formulário não está aberto.</h1>
      <p class="intro">Ele pode ter sido desligado ou o endereço pode estar errado. Confira o endereço com quem o enviou.</p>`,
  );
}

export function fullPage(brand: string): string {
  return shell(
    'Volte mais tarde',
    brand,
    `      <h1>Este formulário recebeu respostas demais hoje.</h1>
      <p class="intro">Tente de novo amanhã, ou fale direto com ${escapeHtml(brand)}.</p>`,
  );
}

/** The service's only style sheet: the same dark ground and type as the app. */
export const FORM_STYLE = `:root {
  --fundo: #141a24;
  --superficie: #1c2431;
  --linha: #2e394b;
  --texto: #e8ebf1;
  --texto-suave: #9ba6b8;
  --marca: #dba63f;
  --sobre-marca: #1b1507;
  --erro: #ef7b6a;
  --foco: #8fb8ff;
  --raio: 6px;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--fundo);
  color: var(--texto);
  font: 400 1rem / 1.5 system-ui, sans-serif;
}
.sheet {
  display: grid;
  gap: 1.25rem;
  max-width: 38rem;
  margin: 0 auto;
  padding: clamp(1.5rem, 6vw, 4rem) 1.25rem 4rem;
}
.brand { margin: 0; font-weight: 650; color: var(--marca); }
h1 { margin: 0; font-size: 1.75rem; line-height: 1.2; }
.intro { margin: 0; color: var(--texto-suave); }
form { display: grid; gap: 1.25rem; }
.question { display: grid; gap: 0.375rem; }
label { font-size: 0.9375rem; font-weight: 600; }
.optional { color: var(--texto-suave); font-weight: 400; }
input, textarea, select {
  width: 100%;
  padding: 0.6875rem 0.75rem;
  border: 1px solid var(--linha);
  border-radius: var(--raio);
  background: var(--superficie);
  color: var(--texto);
  font: inherit;
}
textarea { resize: vertical; }
input[aria-invalid='true'], textarea[aria-invalid='true'], select[aria-invalid='true'] {
  border-color: var(--erro);
}
.money { display: flex; gap: 0.5rem; align-items: center; }
.tick { display: flex; gap: 0.625rem; align-items: center; }
.tick input { width: 1.25rem; height: 1.25rem; accent-color: var(--marca); }
:focus-visible { outline: 2px solid var(--foco); outline-offset: 2px; }
.error { margin: 0; color: var(--erro); font-size: 0.9375rem; }
.summary {
  margin: 0;
  padding: 0.75rem 1rem;
  border-left: 3px solid var(--erro);
  background: var(--superficie);
}
button {
  justify-self: start;
  padding: 0.75rem 1.5rem;
  border: 0;
  border-radius: var(--raio);
  background: var(--marca);
  color: var(--sobre-marca);
  font: 650 1rem / 1.2 system-ui, sans-serif;
  cursor: pointer;
}
.trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
.foot { margin: 0; color: var(--texto-suave); font-size: 0.875rem; }
`;
