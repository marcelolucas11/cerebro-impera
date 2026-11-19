import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { buildFormsApp } from '../src/forms/server.js';
import { hardenDatabase } from '../src/migrate.js';
import { checkStamp, issueStamp } from '../src/forms/stamp.js';
import {
  createTestEnv,
  expireStepUp,
  FORMS_ORIGIN,
  type Person,
  type TestEnv,
} from './support/env.js';
import {
  attempt,
  attemptAlone,
  bind,
  buildScenario,
  connectAs,
  type Scenario,
} from './support/scenario.js';

/*
 * Public forms: made by whoever manages the list, with the code confirmed
 * again; served by a service of their own that can only show and send them;
 * what is sent arrives as an item of the list, as its author's, marked as the
 * form's, and only while the author could add it by hand.
 */

const HOST = new URL(FORMS_ORIGIN).host;

interface FormView {
  id: string;
  title: string;
  address: string | null;
  enabled: boolean;
  sentToday: number;
  sentTotal: number;
  error?: { code: string };
}

let env: TestEnv;
let s: Scenario;
let forms: FastifyInstance;
let formsPool: pg.Pool;
const clock = Date.UTC(2030, 0, 1, 12, 0, 0);
const key = randomBytes(32);
const field = { company: '', topic: '', budget: '', agree: '', email: '', people: '' };
const option = { quote: '', support: '' };

const confirmCode = (person: Person): Promise<unknown> =>
  env.admin.query(`UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1`, [person.id]);

async function newField(body: Record<string, unknown>): Promise<string> {
  const made = await s.owner.browser.post<{ id: string; config: { options?: { id: string }[] } }>(
    `/api/lists/${s.tarefas}/fields`,
    body,
  );
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  if (body.kind === 'select') {
    option.quote = made.body.config.options?.[0]?.id ?? '';
    option.support = made.body.config.options?.[1]?.id ?? '';
  }
  return made.body.id;
}

const formBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Pedido de orçamento',
  intro: 'Conte o que precisa.\n\nRespondemos em até dois dias.',
  titleLabel: 'Seu nome',
  descriptionLabel: 'O que você precisa',
  fields: [
    { id: field.company, required: true },
    { id: field.topic, required: true },
    { id: field.budget, required: false },
    { id: field.agree, required: true },
    { id: field.email, required: false },
  ],
  stageId: null,
  enabled: true,
  ...overrides,
});

function page(url: string, headers: Record<string, string> = {}) {
  return forms.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });
}

function send(slug: string, answers: Record<string, string>, headers: Record<string, string> = {}) {
  return forms.inject({
    method: 'POST',
    url: `/f/${slug}`,
    headers: {
      host: HOST,
      origin: FORMS_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: new URLSearchParams(answers).toString(),
  });
}

const slugOf = (form: FormView): string => form.address?.split('/f/')[1] ?? '';
const stampFor = (slug: string): string => issueStamp(key, slug, clock - 10_000);

async function itemsOfList(): Promise<{ id: string; title: string; form_id: string | null }[]> {
  return (
    await env.admin.query<{ id: string; title: string; form_id: string | null }>(
      `SELECT id, title, form_id FROM app.items WHERE list_id = $1 AND form_id IS NOT NULL
       ORDER BY created_at`,
      [s.tarefas],
    )
  ).rows;
}

let form: FormView;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  const shared = inject('testDatabase');
  formsPool = new pg.Pool({
    ...env.dbConfig,
    user: 'cerebro_forms',
    password: shared.formsPassword,
    max: 3,
  });
  forms = await buildFormsApp({
    pool: formsPool,
    key,
    origin: FORMS_ORIGIN,
    trustProxy: 0,
    now: () => clock,
    logger: false,
    sendsPerWindow: 1000,
  });

  field.company = await newField({ name: 'Empresa', kind: 'text' });
  field.topic = await newField({
    name: 'Assunto',
    kind: 'select',
    config: { options: [{ name: 'Orçamento' }, { name: 'Suporte' }] },
  });
  field.budget = await newField({ name: 'Verba', kind: 'money', config: { currency: 'BRL' } });
  field.agree = await newField({ name: 'Aceita contato', kind: 'checkbox' });
  field.email = await newField({ name: 'E-mail', kind: 'email' });
  field.people = await newField({ name: 'Responsável', kind: 'people' });
});
afterAll(async () => {
  await forms.close();
  await formsPool.end();
  await env.close();
});

describe('making a form', () => {
  it('is for whoever manages the list, with the code confirmed again', async () => {
    for (const person of [s.ana, s.bruno, s.nuno]) {
      // Ana and Bruno edit the list but do not manage it; Nuno does not see it at all.
      const seen = await person.browser.get(`/api/lists/${s.tarefas}/forms`);
      expect(seen.status, person.id).toBe(person === s.nuno ? 404 : 403);
      const made = await person.browser.post(`/api/lists/${s.tarefas}/forms`, formBody());
      expect([403, 404], person.id).toContain(made.status);
    }

    await expireStepUp(env, s.owner);
    const unconfirmed = await s.owner.browser.post<FormView>(
      `/api/lists/${s.tarefas}/forms`,
      formBody(),
    );
    expect(unconfirmed.body.error?.code).toBe('step_up_required');

    await confirmCode(s.owner);
    const made = await s.owner.browser.post<FormView>(`/api/lists/${s.tarefas}/forms`, formBody());
    expect(made.status).toBe(200);
    form = made.body;
    expect(form.address).toMatch(/^https:\/\/formularios\.exemplo\.test\/f\/[A-Za-z0-9_-]{22}$/);
    expect(form).toMatchObject({ enabled: true, sentToday: 0, sentTotal: 0 });

    const listed = await s.owner.browser.get<FormView[]>(`/api/lists/${s.tarefas}/forms`);
    expect(listed.body.map((f) => f.id)).toEqual([form.id]);
    const record = await env.admin.query(
      `SELECT count(*)::int AS n FROM audit.log WHERE action = 'forms.insert'`,
    );
    expect(record.rows).toEqual([{ n: 1 }]);
  });

  it('asks only fields of its own list that strangers may fill in, and a stage of the list', async () => {
    await confirmCode(s.owner);
    const other = await s.owner.browser.post<{ id: string }>(`/api/lists/${s.perfis}/fields`, {
      name: 'Outro',
      kind: 'text',
    });
    const otherStage = await s.owner.browser.get<{ id: string }[]>(`/api/lists/${s.perfis}/stages`);
    const secret = await newField({ name: 'Senha do cliente', kind: 'secret' });
    const archived = await newField({ name: 'Antigo', kind: 'text' });
    await s.owner.browser.patch(`/api/fields/${archived}`, { archived: true });
    for (const [what, body] of [
      ['people', formBody({ fields: [{ id: field.people, required: false }] })],
      ['secret', formBody({ fields: [{ id: secret, required: false }] })],
      ['archived', formBody({ fields: [{ id: archived, required: false }] })],
      ['other list', formBody({ fields: [{ id: other.body.id, required: false }] })],
      ['stage', formBody({ stageId: otherStage.body[0]?.id })],
    ] as const) {
      const refused = await s.owner.browser.post<FormView>(`/api/lists/${s.tarefas}/forms`, body);
      expect(refused.status, what).toBe(400);
    }
    const twice = await s.owner.browser.post(
      `/api/lists/${s.tarefas}/forms`,
      formBody({
        fields: [
          { id: field.company, required: true },
          { id: field.company, required: false },
        ],
      }),
    );
    expect(twice.status).toBe(400);
  });
});

describe('where a form sends', () => {
  it('sends to the stage it names, and only to one its author could put items in', async () => {
    const stages = await s.owner.browser.get<{ id: string }[]>(`/api/lists/${s.tarefas}/stages`);
    const second = stages.body[1]?.id ?? '';
    await confirmCode(s.owner);
    expect(
      (await s.owner.browser.patch(`/api/stages/${second}`, { entryRole: 'owner' })).status,
    ).toBe(200);
    await confirmCode(s.marta);
    const refused = await s.marta.browser.post<FormView>(
      `/api/lists/${s.tarefas}/forms`,
      formBody({ title: 'Direto para a etapa', fields: [], stageId: second }),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('stage_restricted');

    const made = await s.owner.browser.post<FormView>(
      `/api/lists/${s.tarefas}/forms`,
      formBody({ title: 'Direto para a etapa', fields: [], stageId: second }),
    );
    expect(made.status).toBe(200);
    const slug = slugOf(made.body);
    expect(
      (await send(slug, { _stamp: stampFor(slug), title: 'Na segunda etapa' })).statusCode,
    ).toBe(303);
    const landed = await env.admin.query(
      `SELECT stage_id FROM app.items WHERE title = 'Na segunda etapa'`,
    );
    expect(landed.rows).toEqual([{ stage_id: second }]);
    await s.owner.browser.patch(`/api/stages/${second}`, { entryRole: null });
    expect((await s.owner.browser.delete(`/api/forms/${made.body.id}`)).status).toBe(200);
  });
});

describe('the forms service', () => {
  it('shows the form with no script, and nothing of the app', async () => {
    const shown = await page(`/f/${slugOf(form)}`);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(shown.headers['set-cookie']).toBeUndefined();
    // Its own posts keep their origin; nothing goes to another site.
    expect(shown.headers['referrer-policy']).toBe('same-origin');
    expect(shown.body).toContain('Pedido de orçamento');
    expect(shown.body).toContain('Respondemos em até dois dias.');
    expect(shown.body).toContain('Aceita contato');
    expect(shown.body).toContain('Suporte');
    expect(shown.body).toContain('Empresa Exemplo');
    expect(shown.body).not.toMatch(/<script/i);
    // An option taken out of use is not offered to strangers.
    await confirmCode(s.owner);
    const archive = (archived: boolean) =>
      s.owner.browser.patch(`/api/fields/${field.topic}`, {
        config: {
          options: [
            { id: option.quote, name: 'Orçamento' },
            { id: option.support, name: 'Suporte', archived },
          ],
        },
      });
    expect((await archive(true)).status).toBe(200);
    expect((await page(`/f/${slugOf(form)}`)).body).not.toContain('Suporte');
    expect((await archive(false)).status).toBe(200);
    expect(shown.body).not.toContain('Responsável');
    expect(shown.body).not.toContain('Tarefas');

    for (const path of ['/api/me', '/api/brand', '/', '/index.html', '/manifest.webmanifest']) {
      expect((await page(path)).statusCode, path).toBe(404);
    }
    // Under any other name, nothing at all.
    expect((await page(`/f/${slugOf(form)}`, { host: 'cerebro.exemplo.test' })).statusCode).toBe(
      404,
    );
    expect((await page('/f/AAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
    // Only the health check answers under another name, and it says nothing.
    const health = await page('/health', { host: '127.0.0.1:3001' });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"status":"ok"}');
    expect((await page('/health?x', { host: '127.0.0.1:3001' })).statusCode).toBe(404);
    expect((await page('/f/curto')).statusCode).toBe(404);
  });

  it('sends an answer that arrives as an item of the list, as its author’s, marked as the form’s', async () => {
    const slug = slugOf(form);
    const answers = {
      _stamp: stampFor(slug),
      title: '  Maria Cliente  ',
      description: 'Preciso de um site.',
      [`f_${field.company}`]: 'Padaria Boa',
      [`f_${field.topic}`]: option.quote,
      [`f_${field.budget}`]: '1.500,50',
      [`f_${field.agree}`]: 'sim',
      [`f_${field.email}`]: '',
      // Not asked by the form: ignored.
      [`f_${field.people}`]: s.ana.id,
    };
    const sent = await send(slug, answers);
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`/f/${slug}/enviado`);
    const thanks = await page(`/f/${slug}/enviado`);
    expect(thanks.body).toContain('Recebido, obrigado.');

    const item = (await itemsOfList()).find((found) => found.title === 'Maria Cliente');
    expect(item).toMatchObject({ title: 'Maria Cliente', form_id: form.id });
    const stored = await env.admin.query(
      `SELECT i.description, i.created_by, i.stage_id = (
                SELECT st.id FROM app.list_stages st WHERE st.list_id = i.list_id
                ORDER BY st.position, st.created_at LIMIT 1) AS first_stage
       FROM app.items i WHERE i.id = $1`,
      [item?.id],
    );
    expect(stored.rows[0]).toEqual({
      description: 'Preciso de um site.',
      created_by: s.owner.id,
      first_stage: true,
    });
    const values = await env.admin.query<{ field_id: string; value: unknown }>(
      `SELECT field_id, value FROM app.item_field_values WHERE item_id = $1`,
      [item?.id],
    );
    expect(Object.fromEntries(values.rows.map((r) => [r.field_id, r.value]))).toEqual({
      [field.company]: 'Padaria Boa',
      [field.topic]: option.quote,
      [field.budget]: 150050,
      [field.agree]: true,
    });

    // In the history: sent by the form, on behalf of its author.
    const history = await s.owner.browser.get<
      { what: string; actor: string; form: { title: string | null } | null }[]
    >(`/api/items/${item?.id ?? ''}/history`);
    const created = history.body.find((change) => change.what === 'created');
    expect(created).toMatchObject({ actor: s.owner.id, form: { title: 'Pedido de orçamento' } });

    const listed = await s.owner.browser.get<FormView[]>(`/api/lists/${s.tarefas}/forms`);
    expect(listed.body[0]).toMatchObject({ sentToday: 1, sentTotal: 1 });
  });

  it('says what to fix, keeps what was typed, and saves nothing until it fits', async () => {
    const slug = slugOf(form);
    const before = (await itemsOfList()).length;
    const refused = await send(slug, {
      _stamp: stampFor(slug),
      title: 'José',
      [`f_${field.company}`]: '',
      [`f_${field.topic}`]: '00000000-0000-4000-8000-000000000000',
      [`f_${field.budget}`]: 'mil reais',
      [`f_${field.email}`]: 'jose-sem-arroba',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('Confira as respostas marcadas');
    expect(refused.body).toContain('Responda esta pergunta.');
    expect(refused.body).toContain('Escolha uma das opções.');
    expect(refused.body).toContain('Escreva um número, como 1.250,50');
    expect(refused.body).toContain('Escreva um e-mail, como nome@exemplo.com.br');
    expect(refused.body).toContain('Marque para enviar.');
    expect(refused.body).toContain('value="jose-sem-arroba"');
    expect((await itemsOfList()).length).toBe(before);

    // Whatever was typed comes back escaped, never as markup.
    const odd = await send(slug, {
      _stamp: stampFor(slug),
      title: '<script>alert(1)</script>',
      [`f_${field.email}`]: '"><img src=x onerror=alert(1)>',
    });
    expect(odd.statusCode).toBe(400);
    expect(odd.body).not.toContain('<script>alert(1)');
    expect(odd.body).not.toContain('<img src=x');
    expect(odd.body).toContain('&lt;script&gt;');
  });

  it('keeps out robots and posts from anywhere else', async () => {
    const slug = slugOf(form);
    const before = (await itemsOfList()).length;
    const full = {
      title: 'Robô',
      [`f_${field.company}`]: 'X',
      [`f_${field.topic}`]: option.support,
      [`f_${field.agree}`]: 'sim',
    };
    // Filled the hidden question: thanked, and nothing kept.
    const robot = await send(slug, { ...full, _stamp: stampFor(slug), _site: 'http://spam' });
    expect(robot.statusCode).toBe(303);
    // Too fast, too old, forged, or from another form's page.
    const fast = await send(slug, { ...full, _stamp: issueStamp(key, slug, clock - 1_000) });
    expect(fast.body).toContain('Envio rápido demais');
    const old = await send(slug, { ...full, _stamp: issueStamp(key, slug, clock - 7 * 3_600_000) });
    expect(old.body).toContain('A página ficou aberta muito tempo');
    const forged = await send(slug, {
      ...full,
      _stamp: issueStamp(randomBytes(32), slug, clock - 9_000),
    });
    expect(forged.body).toContain('Envie pela própria página');
    const elsewhere = await send(slug, {
      ...full,
      _stamp: issueStamp(key, 'B'.repeat(22), clock - 9_000),
    });
    expect(elsewhere.statusCode).toBe(400);
    // Posted from another site, or as anything but a plain form.
    expect(
      (await send(slug, { ...full, _stamp: stampFor(slug) }, { origin: 'https://outro.test' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send(slug, { ...full, _stamp: stampFor(slug) }, { 'sec-fetch-site': 'cross-site' }))
        .statusCode,
    ).toBe(403);
    const json = await forms.inject({
      method: 'POST',
      url: `/f/${slug}`,
      headers: { host: HOST, origin: FORMS_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...full, _stamp: stampFor(slug) }),
    });
    expect(json.statusCode).toBe(415);
    const twice = await forms.inject({
      method: 'POST',
      url: `/f/${slug}`,
      headers: {
        host: HOST,
        origin: FORMS_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `title=a&title=b&_stamp=${stampFor(slug)}`,
    });
    expect(twice.statusCode).toBe(400);
    expect((await itemsOfList()).length).toBe(before);
  });

  it('closes when switched off, and when its author could no longer add items by hand', async () => {
    // Marta manages the list's space; the form she saves sends as her.
    await confirmCode(s.marta);
    const hers = await s.marta.browser.post<FormView>(
      `/api/lists/${s.tarefas}/forms`,
      formBody({ title: 'Formulário da Marta', fields: [] }),
    );
    expect(hers.status).toBe(200);
    // Someone who is not an owner opened a door into a list: the owners are told.
    const alerts = await env.admin.query(
      `SELECT count(*)::int AS n FROM app.security_alerts
       WHERE kind = 'permission_changed' AND metadata ->> 'table' = 'forms'`,
    );
    expect(alerts.rows).toEqual([{ n: 1 }]);
    const slug = slugOf(hers.body);
    expect((await page(`/f/${slug}`)).statusCode).toBe(200);

    await env.admin.query(`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.marta.id]);
    expect((await page(`/f/${slug}`)).statusCode).toBe(404);
    const closed = await send(slug, { _stamp: stampFor(slug), title: 'Depois' });
    expect(closed.statusCode).toBe(404);
    await env.admin.query(`UPDATE app.users SET status = 'active' WHERE id = $1`, [s.marta.id]);
    expect((await page(`/f/${slug}`)).statusCode).toBe(200);

    await confirmCode(s.owner);
    const off = await s.owner.browser.put<FormView>(
      `/api/forms/${hers.body.id}`,
      formBody({ title: 'Formulário da Marta', fields: [], enabled: false }),
    );
    expect(off.body.enabled).toBe(false);
    // Saving makes it act as whoever saved it.
    const runAs = await env.admin.query(`SELECT run_as FROM app.forms WHERE id = $1`, [
      hers.body.id,
    ]);
    expect(runAs.rows).toEqual([{ run_as: s.owner.id }]);
    expect((await page(`/f/${slug}`)).statusCode).toBe(404);

    expect((await s.owner.browser.delete(`/api/forms/${hers.body.id}`)).status).toBe(200);
    expect((await page(`/f/${slug}`)).statusCode).toBe(404);
  });

  it('takes at most 500 answers a day from one form, however many send', async () => {
    const slug = slugOf(form);
    await env.admin.query(
      `INSERT INTO app.form_submissions (form_id, item_id)
       SELECT $1, gen_random_uuid() FROM generate_series(1, 498)`,
      [form.id],
    );
    const answer = (title: string) => ({
      _stamp: stampFor(slug),
      title,
      [`f_${field.company}`]: 'X',
      [`f_${field.topic}`]: option.support,
      [`f_${field.agree}`]: 'sim',
    });
    expect((await send(slug, answer('Quingentésimo'))).statusCode).toBe(303);
    const full = await send(slug, answer('Um a mais'));
    expect(full.statusCode).toBe(503);
    expect(full.body).toContain('respostas demais hoje');
    // A day later the count starts over.
    await env.admin.query(`UPDATE app.form_submissions SET at = at - interval '25 hours'`);
    expect((await send(slug, answer('No dia seguinte'))).statusCode).toBe(303);
  });
});

describe('the forms role in the database', () => {
  it('reads no table and runs nothing but the forms', async () => {
    const role = await connectAs(env, 'cerebro_forms');
    try {
      for (const statement of [
        'SELECT * FROM app.items',
        'SELECT * FROM app.forms',
        'SELECT * FROM app.users',
        'SELECT * FROM auth.sessions',
        'INSERT INTO app.form_submissions (form_id, item_id) VALUES (gen_random_uuid(), gen_random_uuid())',
        "SELECT authz.begin_request('\\x00'::bytea, NULL)",
        'SELECT app.form_title(gen_random_uuid())',
      ]) {
        expect((await attemptAlone(role, statement)).code, statement).toBe('42501');
      }
      // The functions themselves hold the line too.
      const slug = slugOf(form);
      const unknown = await attemptAlone(role, 'SELECT app.form_submit($1, $2, NULL, $3::jsonb)', [
        slug,
        'Alguém',
        JSON.stringify({
          [field.company]: 'X',
          [field.topic]: option.support,
          [field.agree]: true,
          [field.people]: [s.ana.id],
        }),
      ]);
      expect(unknown.code).toBe('22023');
      const missing = await attemptAlone(role, 'SELECT app.form_submit($1, $2, NULL, $3::jsonb)', [
        slug,
        'Alguém',
        JSON.stringify({}),
      ]);
      expect(missing.code).toBe('22023');
      const bad = await attemptAlone(role, 'SELECT app.form_submit($1, $2, NULL, $3::jsonb)', [
        slug,
        'Alguém',
        JSON.stringify({ [field.company]: 'X', [field.topic]: 'nada', [field.agree]: true }),
      ]);
      expect(bad.code).toBe('23514');
      const answered = JSON.stringify({
        [field.company]: 'X',
        [field.topic]: option.support,
        [field.agree]: true,
      });
      for (const [what, title, description] of [
        ['no title', '   ', null],
        ['long title', 'x'.repeat(501), null],
        ['long description', 'Alguém', 'x'.repeat(5001)],
      ] as const) {
        const refused = await attemptAlone(role, 'SELECT app.form_submit($1, $2, $3, $4::jsonb)', [
          slug,
          title,
          description,
          answered,
        ]);
        expect(refused.code, what).toBe('22023');
      }
      expect(
        (await attemptAlone(role, `SELECT app.form_submit($1, 'A', NULL, '[]'::jsonb)`, [slug]))
          .code,
      ).toBe('22023');
      // Switched off, or its author suspended: closed here too, not only on the page.
      await env.admin.query(`UPDATE app.forms SET enabled = false WHERE id = $1`, [form.id]);
      expect(
        (
          await attemptAlone(role, 'SELECT app.form_submit($1, $2, NULL, $3::jsonb) AS o', [
            slug,
            'Alguém',
            answered,
          ])
        ).rows,
      ).toEqual([{ o: 'closed' }]);
      await env.admin.query(`UPDATE app.forms SET enabled = true WHERE id = $1`, [form.id]);
      await env.admin.query(`UPDATE app.forms SET run_as = $2 WHERE id = $1`, [
        form.id,
        s.marta.id,
      ]);
      await env.admin.query(`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [
        s.marta.id,
      ]);
      expect(
        (
          await attemptAlone(role, 'SELECT app.form_submit($1, $2, NULL, $3::jsonb) AS o', [
            slug,
            'Alguém',
            answered,
          ])
        ).rows,
      ).toEqual([{ o: 'closed' }]);
      await env.admin.query(`UPDATE app.users SET status = 'active' WHERE id = $1`, [s.marta.id]);
      await env.admin.query(`UPDATE app.forms SET run_as = $2 WHERE id = $1`, [
        form.id,
        s.owner.id,
      ]);
      // A form that does not ask for a description takes none.
      const plain = (
        await env.admin.query<{ slug: string }>(
          `INSERT INTO app.forms (list_id, title, title_label, run_as)
           VALUES ($1, 'Sem descrição', 'Nome', $2) RETURNING slug`,
          [s.tarefas, s.owner.id],
        )
      ).rows[0]?.slug;
      expect(
        (await attemptAlone(role, `SELECT app.form_submit($1, 'A', 'Texto', '{}'::jsonb)`, [plain]))
          .code,
      ).toBe('22023');
      expect(
        (
          await attemptAlone(role, `SELECT app.form_submit($1, 'A', NULL, '{}'::jsonb) AS o`, [
            plain,
          ])
        ).rows,
      ).toEqual([{ o: 'sent' }]);
      await env.admin.query(`DELETE FROM app.forms WHERE slug = $1`, [plain]);
    } finally {
      await role.end();
    }
  });

  it('lets the app neither show nor send forms, nor anyone without the power make one', async () => {
    const app = await connectAs(env, 'cerebro_app');
    try {
      expect(await bind(app, s.owner)).toBe(true);
      expect((await attempt(app, `SELECT app.form_view('x')`)).code).toBe('42501');
      expect((await attempt(app, `SELECT app.form_submit('x', 'y', NULL, '{}'::jsonb)`)).code).toBe(
        '42501',
      );
      // Its address and its list never change.
      expect(
        (await attempt(app, `UPDATE app.forms SET slug = 'AAAAAAAAAAAAAAAAAAAAAA'`)).code,
      ).toBe('42501');
      await app.query('ROLLBACK');

      expect(await bind(app, s.ana)).toBe(true);
      const insert = `INSERT INTO app.forms (list_id, title, title_label) VALUES ($1, 'X', 'Nome')`;
      expect((await attempt(app, insert, [s.tarefas])).code).toBe('42501');
      expect((await attempt(app, 'SELECT count(*)::int AS n FROM app.forms')).rows).toEqual([
        { n: 0 },
      ]);
      expect(
        (await attempt(app, 'SELECT count(*)::int AS n FROM app.form_submissions')).rows,
      ).toEqual([{ n: 0 }]);
      await app.query('ROLLBACK');

      await expireStepUp(env, s.owner);
      expect(await bind(app, s.owner)).toBe(true);
      expect((await attempt(app, insert, [s.tarefas])).code).toBe('42501');
      expect(await attempt(app, `UPDATE app.forms SET enabled = false`)).toMatchObject({
        ok: true,
        rowCount: 0,
      });
      expect((await attempt(app, `DELETE FROM app.forms`)).rowCount).toBe(0);
      await app.query('ROLLBACK');

      await confirmCode(s.owner);
      expect(await bind(app, s.owner)).toBe(true);
      const people = await attempt(
        app,
        `INSERT INTO app.forms (list_id, title, title_label, fields) VALUES ($1, 'X', 'Nome', $2::jsonb)`,
        [s.tarefas, JSON.stringify([{ id: field.people, required: false }])],
      );
      expect(people.code).toBe('23514');
      const author = await attempt(
        app,
        `INSERT INTO app.forms (list_id, title, title_label, run_as) VALUES ($1, 'X', 'Nome', $2)`,
        [s.tarefas, s.ana.id],
      );
      expect(author.code).toBe('42501');
      // What a form asks is checked by the database too, whoever writes it.
      const otherField = (
        await env.admin.query<{ id: string }>(`SELECT id FROM app.list_fields WHERE list_id = $1`, [
          s.perfis,
        ])
      ).rows[0]?.id;
      const archived = (
        await env.admin.query<{ id: string }>(
          `SELECT id FROM app.list_fields WHERE list_id = $1 AND is_archived`,
          [s.tarefas],
        )
      ).rows[0]?.id;
      const extra = await env.admin.query<{ id: string }>(
        `INSERT INTO app.list_fields (list_id, name, kind, created_by)
         SELECT $1, 'Pergunta ' || n, 'text', $2 FROM generate_series(1, 21) AS n RETURNING id`,
        [s.tarefas, s.owner.id],
      );
      const manyFields = extra.rows.map((row) => ({ id: row.id, required: false }));
      for (const [what, fields] of [
        ['other list', [{ id: otherField, required: false }]],
        ['archived', [{ id: archived, required: false }]],
        [
          'twice',
          [
            { id: field.company, required: false },
            { id: field.company, required: true },
          ],
        ],
        ['too many', manyFields],
        ['extra key', [{ id: field.company, required: false, label: 'x' }]],
        ['not boolean', [{ id: field.company, required: 'sim' }]],
        ['not a list', { id: field.company }],
      ] as const) {
        const refused = await attempt(
          app,
          `INSERT INTO app.forms (list_id, title, title_label, fields) VALUES ($1, 'X', 'Nome', $2::jsonb)`,
          [s.tarefas, JSON.stringify(fields)],
        );
        expect(refused.code, what).toBe('23514');
      }
      const otherStage = (
        await env.admin.query<{ id: string }>(`SELECT id FROM app.list_stages WHERE list_id = $1`, [
          s.perfis,
        ])
      ).rows[0]?.id;
      expect(
        (
          await attempt(
            app,
            `INSERT INTO app.forms (list_id, title, title_label, stage_id) VALUES ($1, 'X', 'Nome', $2)`,
            [s.tarefas, otherStage],
          )
        ).code,
      ).toBe('23514');
      // Twenty forms a list, at most.
      const many = await attempt(
        app,
        `INSERT INTO app.forms (list_id, title, title_label)
         SELECT $1, 'Muitos ' || n, 'Nome' FROM generate_series(1, 20) AS n`,
        [s.tarefas],
      );
      expect(many.code).toBe('CB003');
      // The mark of a form on an item is the database's to write.
      expect(
        (
          await attempt(
            app,
            `INSERT INTO app.items (list_id, title, created_by, form_id) VALUES ($1, 'X', $2, $3)`,
            [s.tarefas, s.owner.id, form.id],
          )
        ).code,
      ).toBe('42501');
      await app.query('ROLLBACK');
      await env.admin.query(
        `UPDATE app.list_fields SET is_archived = true WHERE name LIKE 'Pergunta %'`,
      );

      // Someone who edits the list, with the code confirmed, still changes no form.
      await confirmCode(s.ana);
      expect(await bind(app, s.ana)).toBe(true);
      // Not refused on writing: the rows are simply not there for her.
      expect(await attempt(app, `UPDATE app.forms SET enabled = false`)).toMatchObject({
        ok: true,
        rowCount: 0,
      });
      expect((await attempt(app, `DELETE FROM app.forms`)).rowCount).toBe(0);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('connects to a hardened database, as the other two services do, and no one else', async () => {
    const client = await env.admin.connect();
    try {
      await hardenDatabase(client);
      const can = await client.query(
        `SELECT has_database_privilege('cerebro_forms', current_database(), 'CONNECT') AS forms,
                has_database_privilege('cerebro_app', current_database(), 'CONNECT') AS app,
                has_database_privilege('public', current_database(), 'CONNECT') AS anyone`,
      );
      expect(can.rows).toEqual([{ forms: true, app: true, anyone: false }]);
    } finally {
      client.release();
    }
    expect((await page(`/f/${slugOf(form)}`)).statusCode).toBe(200);
  });

  it('signs the page stamp so it cannot be moved to another form or forged', () => {
    const stamp = issueStamp(key, 'A'.repeat(22), 1_000_000);
    expect(checkStamp(key, 'A'.repeat(22), stamp, 1_005_000)).toBe('ok');
    expect(checkStamp(key, 'B'.repeat(22), stamp, 1_005_000)).toBe('invalid');
    expect(checkStamp(key, 'A'.repeat(22), stamp, 1_001_000)).toBe('too_fast');
    expect(checkStamp(key, 'A'.repeat(22), stamp, 999_000)).toBe('invalid');
    expect(checkStamp(key, 'A'.repeat(22), `${stamp}x`, 1_005_000)).toBe('invalid');
    expect(checkStamp(key, 'A'.repeat(22), 'nada', 1_005_000)).toBe('invalid');
  });
});
