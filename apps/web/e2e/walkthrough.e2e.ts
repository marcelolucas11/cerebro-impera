import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { authenticatorCode, heading, PASSWORD, setupToken, shot, sql, watch } from './support.js';

/*
 * One installation, from the first minute to a working team, in a real
 * browser against the real API. An owner on a computer and an employee on a
 * phone go through what the system promises: nobody gets in without both
 * factors and an approved device, nobody sees what was not opened to them,
 * and everything is on the record.
 *
 * The steps build on each other, so they run in order and stop at the first
 * failure.
 */

test.describe.configure({ mode: 'serial' });

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const problems: string[] = [];
let ownerContext: BrowserContext;
let owner: Page;
let ownerKey = '';
let anaContext: BrowserContext;
let ana: Page;
let anaKey = '';
let inviteAddress = '';

test.beforeAll(async ({ browser }) => {
  ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await ownerContext.newPage();
  watch(owner, problems, 'dono');
  anaContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    userAgent: IPHONE,
  });
  ana = await anaContext.newPage();
  watch(ana, problems, 'funcionária');
});

test.afterAll(async () => {
  await ownerContext.close();
  await anaContext.close();
});

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await heading(page, 'Entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Continuar' }).click();
}

test('the first owner installs with the server token, an authenticator and recovery codes', async () => {
  await owner.goto('/');
  await heading(owner, 'Instalar');

  // Without the token from the server, the installation cannot be claimed.
  await owner
    .getByLabel('Token de instalação')
    .fill('um-token-inventado-por-quem-nao-tem-o-servidor');
  await owner.getByLabel('Nome da empresa').fill('Empresa Exemplo');
  await owner.getByLabel('Seu nome').fill('Olívia Dona');
  await owner.getByLabel('Seu e-mail').fill('olivia@exemplo.test');

  // A weak password is explained on the spot and blocks the way forward.
  await owner.getByLabel('Crie uma senha').fill('senha');
  await expect(owner.getByText('Use pelo menos 12 caracteres')).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Continuar para o autenticador' })).toBeDisabled();
  await owner.getByLabel('Crie uma senha').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Continuar para o autenticador' }).click();
  await expect(owner.getByRole('alert')).toContainText('Token de instalação incorreto');

  await owner.getByLabel('Token de instalação').fill(setupToken());
  await owner.getByRole('button', { name: 'Continuar para o autenticador' }).click();
  await heading(owner, 'Ligue seu autenticador');
  ownerKey = await owner.locator('.authenticator .exact').innerText();
  await owner
    .getByLabel('Código de 6 dígitos que o aplicativo mostra')
    .fill(await authenticatorCode(ownerKey));
  await owner.getByRole('button', { name: 'Confirmar código' }).click();

  await heading(owner, 'Guarde seus códigos de recuperação');
  await expect(owner.locator('.recovery-codes li')).toHaveCount(10);
  await expect(owner.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  await owner.getByLabel('Guardei os códigos em lugar seguro').check();
  await owner.getByRole('button', { name: 'Continuar' }).click();

  await heading(owner, 'Seus espaços');
  await expect(owner.locator('.shell-brand')).toHaveText('Empresa Exemplo');

  // The door is shut behind the first owner: the setup cannot run a second time.
  const again = await owner.request.get('/api/setup/status');
  expect(await again.json()).toMatchObject({ needsSetup: false });
});

test('signing in takes the password and a fresh code, and survives a reload', async () => {
  await owner.getByRole('button', { name: 'Sair' }).click();
  await signIn(owner, 'olivia@exemplo.test', 'senha-errada-de-proposito');
  await expect(owner.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
  // An address that does not exist gets exactly the same answer.
  await owner.getByLabel('E-mail').fill('ninguem@exemplo.test');
  await owner.getByRole('button', { name: 'Continuar' }).click();
  await expect(owner.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');

  await signIn(owner, 'olivia@exemplo.test', PASSWORD);
  await heading(owner, 'Confirme que é você');
  // The password alone opens nothing.
  expect((await owner.request.get('/api/me')).status()).toBe(401);
  await owner
    .getByLabel('Código de 6 dígitos do aplicativo autenticador')
    .fill(await authenticatorCode(ownerKey));
  await owner.getByRole('button', { name: 'Entrar', exact: true }).click();
  await heading(owner, 'Seus espaços');

  await owner.reload();
  await heading(owner, 'Seus espaços');
});

test('the owner shapes the structure and invites an employee', async () => {
  await owner.getByLabel('Nome do espaço').fill('Operação');
  await owner.getByRole('button', { name: 'Criar espaço' }).click();
  await expect(owner.getByRole('heading', { name: 'Operação' })).toBeVisible();

  await owner.getByRole('button', { name: 'Adicionar lista ou pasta' }).click();
  await owner.getByLabel('Nome', { exact: true }).fill('Tarefas');
  await owner.getByRole('button', { name: 'Criar lista' }).click();
  await expect(owner.locator('.rows').getByText('Tarefas')).toBeVisible();
  await owner.getByLabel('Nome', { exact: true }).fill('Dinheiro');
  await owner.getByLabel(/Lista sensível/).check();
  await owner.getByRole('button', { name: 'Criar lista' }).click();
  await expect(owner.getByText('sensível', { exact: true })).toBeVisible();

  await owner.getByRole('link', { name: 'Pessoas' }).click();
  await heading(owner, 'Pessoas');
  await owner.getByLabel('Nome', { exact: true }).fill('Ana Souza');
  await owner.getByLabel('E-mail').fill('ana@exemplo.test');
  await owner.getByRole('button', { name: 'Convidar', exact: true }).click();
  await expect(owner.getByText('Convite criado.')).toBeVisible();
  inviteAddress = await owner.locator('.panel-brand .exact').innerText();
  expect(inviteAddress).toMatch(/\/convite#[A-Za-z0-9_-]{43}$/);
});

test('the employee accepts on her phone and waits at the door until her device is approved', async () => {
  await ana.goto(inviteAddress);
  await heading(ana, 'Crie seu acesso');
  await ana.getByLabel('Crie uma senha').fill(PASSWORD);
  await ana.getByRole('button', { name: 'Continuar para o autenticador' }).click();
  await heading(ana, 'Ligue seu autenticador');
  // Once used, the token is gone from the address bar.
  expect(ana.url()).not.toContain('#');
  anaKey = await ana.locator('.authenticator .exact').innerText();
  await ana
    .getByLabel('Código de 6 dígitos que o aplicativo mostra')
    .fill(await authenticatorCode(anaKey));
  await ana.getByRole('button', { name: 'Confirmar código' }).click();
  await heading(ana, 'Guarde seus códigos de recuperação');
  await ana.getByLabel('Guardei os códigos em lugar seguro').check();
  await ana.getByRole('button', { name: 'Continuar' }).click();

  await heading(ana, 'Aguardando aprovação deste aparelho');
  // Both factors are right, and still nothing is reachable from this device.
  expect((await ana.request.get('/api/me')).status()).toBe(401);
  expect((await ana.request.get('/api/tree')).status()).toBe(401);
  await ana.reload();
  await heading(ana, 'Aguardando aprovação deste aparelho');

  // The invite worked once. Whoever finds the address later gets nothing.
  const second = await anaContext.newPage();
  await second.goto(inviteAddress);
  await heading(second, 'Crie seu acesso');
  await second.getByLabel('Crie uma senha').fill(PASSWORD);
  await second.getByRole('button', { name: 'Continuar para o autenticador' }).click();
  await expect(second.getByRole('alert')).toContainText('não vale mais');
  await second.close();
});

test('approving a device asks the owner for the second factor again', async () => {
  await owner.getByRole('link', { name: 'Aparelhos' }).click();
  await heading(owner, 'Aparelhos');
  await expect(owner.getByText('Ana Souza')).toBeVisible();
  await expect(owner.locator('main')).toContainText('Safari no iPhone');

  // Time passes: the owner's last confirmation is no longer recent.
  await sql("UPDATE auth.sessions SET step_up_at = now() - interval '1 hour'");
  await owner.getByRole('button', { name: 'Aprovar' }).click();
  const dialog = owner.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Confirme que é você' })).toBeVisible();

  await dialog.getByLabel('Código de 6 dígitos').fill('000000');
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  // A wrong code approves nothing.
  await expect(
    ana.getByRole('heading', { name: 'Aguardando aprovação deste aparelho' }),
  ).toBeVisible();

  await dialog.getByLabel('Código de 6 dígitos').fill(await authenticatorCode(ownerKey));
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(owner.getByText('Nenhum aparelho esperando.')).toBeVisible();
});

test('the employee gets in and sees no data and no administration', async () => {
  // Her page moves on by itself once the approval arrives.
  await heading(ana, 'Dispositivo aprovado');
  await ana.getByRole('button', { name: 'Entrar', exact: true }).click();
  await signIn(ana, 'ana@exemplo.test', PASSWORD);
  await heading(ana, 'Confirme que é você');
  await ana
    .getByLabel('Código de 6 dígitos do aplicativo autenticador')
    .fill(await authenticatorCode(anaKey));
  await ana.getByRole('button', { name: 'Entrar', exact: true }).click();

  await heading(ana, 'Seus espaços');
  await expect(ana.getByText('Você ainda não tem acesso a nenhuma lista.')).toBeVisible();
  const sections = ana.getByRole('navigation');
  await expect(sections.getByRole('link', { name: 'Espaços' })).toBeVisible();
  await expect(sections.getByRole('link', { name: 'Pessoas' })).toHaveCount(0);
  await expect(sections.getByRole('link', { name: 'Segurança' })).toHaveCount(0);

  // Typing the address does not help, and neither does asking the API directly.
  await ana.goto('/pessoas');
  await heading(ana, 'Esta página não existe');
  for (const url of ['/api/users', '/api/audit', '/api/alerts']) {
    expect((await ana.request.get(url)).status(), url).toBe(403);
  }
});

test('opening one list to her shows that list and nothing else', async () => {
  await owner.getByRole('link', { name: 'Pessoas' }).click();
  await heading(owner, 'Pessoas');
  const row = owner.getByRole('row', { name: /Ana Souza/ });
  await expect(row).toContainText('Ativo');
  await row.getByRole('button', { name: 'Gerenciar' }).click();
  await expect(owner.getByRole('heading', { name: 'Ana Souza' })).toBeVisible();
  await owner.getByLabel('Área').selectOption({ label: 'Lista: Operação › Tarefas' });
  await owner.getByRole('button', { name: 'Liberar área' }).click();
  await expect(
    owner.locator('.subsection .rows').getByText('Lista: Operação › Tarefas'),
  ).toBeVisible();

  await ana.goto('/');
  await heading(ana, 'Seus espaços');
  await expect(ana.locator('main')).toContainText('Tarefas');
  await expect(ana.locator('main')).toContainText('Pode editar, só os seus itens');
  await expect(ana.locator('main')).not.toContainText('Dinheiro');
});

test('items live in stages: each person works on what is theirs, and the list keeps the time', async () => {
  const stageOf = (page: Page, name: string) => page.getByRole('region', { name: `Etapa ${name}` });

  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  for (const name of ['A fazer', 'Fazendo', 'Feito']) {
    await expect(stageOf(owner, name)).toContainText('0 itens');
  }
  await stageOf(owner, 'A fazer')
    .getByRole('button', { name: 'Adicionar item em A fazer' })
    .click();
  await stageOf(owner, 'A fazer')
    .getByLabel('Novo item em A fazer')
    .fill('Subir campanha do cliente');
  await stageOf(owner, 'A fazer').getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(stageOf(owner, 'A fazer')).toContainText('Subir campanha do cliente');
  await expect(stageOf(owner, 'A fazer')).toContainText('1 item');

  // The employee opens the same list and sees only what is hers: nothing yet.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await expect(ana.getByText('Você vê aqui só os itens que são seus.')).toBeVisible();
  await expect(ana.locator('main')).not.toContainText('Subir campanha do cliente');
  await expect(ana.getByRole('button', { name: 'Editar etapas' })).toHaveCount(0);

  await stageOf(ana, 'A fazer').getByRole('button', { name: 'Adicionar item em A fazer' }).click();
  await stageOf(ana, 'A fazer').getByLabel('Novo item em A fazer').fill('Conferir perfis');
  await stageOf(ana, 'A fazer').getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(stageOf(ana, 'A fazer')).toContainText('Conferir perfis');
  // What she creates is hers from the start.
  await expect(stageOf(ana, 'A fazer')).toContainText('Com você');
  await ana.getByLabel('Etapa de Conferir perfis').selectOption({ label: 'Fazendo' });
  await expect(stageOf(ana, 'Fazendo')).toContainText('Conferir perfis');
  await expect(stageOf(ana, 'A fazer')).toContainText('0 itens');

  // Opening the item shows where it has been and for how long.
  await ana.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const stays = ana.locator('.stays li');
  await expect(stays).toHaveCount(2);
  await expect(stays.nth(0)).toContainText('A fazer');
  await expect(stays.nth(1)).toContainText('Fazendo');
  await expect(stays.nth(1)).toContainText('etapa atual');
  await expect(stays.nth(1)).toContainText('por você');
  await shot(ana, 'lista-funcionaria-celular');

  // The owner sees everyone's items, and reshapes the stages of the list.
  await owner.reload();
  await heading(owner, 'Tarefas');
  await expect(stageOf(owner, 'Fazendo')).toContainText('Conferir perfis');
  await expect(stageOf(owner, 'Fazendo')).toContainText('Com Ana Souza');
  await owner.getByRole('button', { name: 'Editar etapas' }).click();
  await owner.getByLabel('Nome da nova etapa').fill('Bloqueado');
  await owner.getByRole('button', { name: 'Adicionar etapa' }).click();
  await expect(stageOf(owner, 'Bloqueado')).toBeVisible();
  await shot(owner, 'lista-dono-editando-etapas');

  // A stage that still holds an item is not removed until the item has somewhere to go.
  await owner.getByRole('button', { name: 'Remover A fazer' }).click();
  await expect(owner.getByText('Ainda há itens nesta etapa.').first()).toBeVisible();
  await expect(stageOf(owner, 'A fazer')).toBeVisible();
  await owner.getByLabel('Mover os itens de A fazer para').selectOption({ label: 'Fazendo' });
  await owner.getByRole('button', { name: 'Mover os itens e remover' }).click();
  await expect(stageOf(owner, 'A fazer')).toHaveCount(0);
  await expect(stageOf(owner, 'Fazendo')).toContainText('Subir campanha do cliente');
  await expect(stageOf(owner, 'Fazendo')).toContainText('2 itens');
  await owner.getByRole('button', { name: 'Fechar edição das etapas' }).click();
  await shot(owner, 'lista-dono');

  await ana.reload();
  await heading(ana, 'Tarefas');
  await expect(stageOf(ana, 'A fazer')).toHaveCount(0);
  await expect(stageOf(ana, 'Bloqueado')).toBeVisible();
  await expect(stageOf(ana, 'Fazendo')).toContainText('1 item');
});

test('a list records what the team needs about each item, and each person sees only their own', async () => {
  const row = (page: Page, title: string) =>
    page.locator('.item-rows > li').filter({ hasText: title });

  // The owner decides what this list records.
  await owner.getByRole('button', { name: 'Editar campos' }).click();
  await expect(owner.getByText('Esta lista ainda não tem campos.')).toBeVisible();
  await owner.getByLabel('Nome do novo campo').fill('Fornecedor');
  await owner.getByLabel('Tipo do novo campo').selectOption({ label: 'Escolha única' });
  await owner.getByLabel('Opção 1 de novo campo').fill('Alfa');
  await owner.getByLabel('Opção 2 de novo campo').fill('Beta');
  await owner.getByRole('button', { name: 'Adicionar campo' }).click();
  await expect(owner.getByLabel('Opção 2 de Fornecedor')).toHaveValue('Beta');
  for (const [name, kind] of [
    ['Valor', 'Dinheiro'],
    ['Data de compra', 'Data'],
    ['Painel', 'Link'],
  ] as const) {
    await owner.getByLabel('Nome do novo campo').fill(name);
    await owner.getByLabel('Tipo do novo campo').selectOption({ label: kind });
    await owner.getByRole('button', { name: 'Adicionar campo' }).click();
    await expect(owner.getByRole('button', { name: `Arquivar campo ${name}` })).toBeVisible();
  }
  await shot(owner, 'lista-dono-editando-campos');
  await owner.getByRole('button', { name: 'Fechar edição dos campos' }).click();
  await expect(owner.locator('.item-head').first()).toContainText('Fornecedor');
  await expect(owner.locator('.item-head').first()).toContainText('Data de compra');

  // Filling them in: what does not fit is explained before anything is sent.
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const panel = row(owner, 'Subir campanha do cliente').locator('.item-panel');
  await panel.getByLabel('Fornecedor', { exact: true }).selectOption({ label: 'Beta' });
  await panel.getByLabel('Valor (BRL)').fill('1.499,90');
  await panel.getByLabel('Data de compra').fill('2026-11-03');
  await panel.getByLabel('Painel').fill('javascript:alert(1)');
  await expect(panel.getByText('Escreva o endereço completo')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Salvar item' })).toBeDisabled();
  await panel.getByLabel('Painel').fill('https://exemplo.test/painel');
  await panel.getByRole('button', { name: 'Salvar item' }).click();
  const filled = row(owner, 'Subir campanha do cliente').locator('.item-row');
  await expect(filled).toContainText('Beta');
  await expect(filled).toContainText('1.499,90');
  await expect(filled).toContainText('03/11/2026');
  await expect(filled.getByRole('link', { name: 'https://exemplo.test/painel' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await shot(owner, 'lista-dono-campos');

  // The employee sees the fields, fills in her own item, and nothing of anyone else's.
  await ana.reload();
  await heading(ana, 'Tarefas');
  await expect(ana.getByRole('button', { name: 'Editar campos' })).toHaveCount(0);
  await expect(ana.getByText('Subir campanha do cliente')).toHaveCount(0);
  await expect(ana.getByText('1.499,90')).toHaveCount(0);
  await ana.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const hers = row(ana, 'Conferir perfis').locator('.item-panel');
  await hers.getByLabel('Fornecedor', { exact: true }).selectOption({ label: 'Alfa' });
  await hers.getByLabel('Valor (BRL)').fill('250');
  await hers.getByRole('button', { name: 'Salvar item' }).click();
  await expect(row(ana, 'Conferir perfis').locator('.item-row')).toContainText('Fornecedor: Alfa');
  await expect(row(ana, 'Conferir perfis').locator('.item-row')).toContainText(
    /Valor: R\$\s250,00/,
  );
  // A field with nothing in it takes no room on a phone.
  await expect(
    row(ana, 'Conferir perfis').locator('.item-cell', { hasText: 'Data de compra' }),
  ).toBeHidden();
  await shot(ana, 'lista-funcionaria-campos');

  await owner.reload();
  await heading(owner, 'Tarefas');
  await expect(row(owner, 'Conferir perfis').locator('.item-row')).toContainText('Alfa');
  await expect(row(owner, 'Conferir perfis').locator('.item-row')).toContainText('250,00');

  // Everything done to an item is on its history, said in words, newest first.
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const opened = row(owner, 'Conferir perfis').locator('.item-panel');
  await opened.getByRole('button', { name: 'Ver o que mudou neste item' }).click();
  const story = opened.locator('.changes > li');
  await expect(story.first()).toContainText('Ana Souza preencheu');
  await expect(story.filter({ hasText: 'Ana Souza preencheu Fornecedor: Alfa' })).toHaveCount(1);
  await expect(story.filter({ hasText: /Ana Souza preencheu Valor: R\$\s250,00/ })).toHaveCount(1);
  await expect(story.last()).toContainText('criou o item');
  await shot(owner, 'historico-do-item');
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();

  // An item thrown away leaves the list, waits in the trash, and comes back as it was.
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  await row(owner, 'Subir campanha do cliente')
    .getByRole('button', { name: 'Mandar para a lixeira Subir campanha do cliente' })
    .click();
  await expect(owner.locator('.item-rows').getByText('Subir campanha do cliente')).toHaveCount(0);
  await owner.getByRole('button', { name: 'Lixeira' }).click();
  const binned = owner.locator('.trash li').filter({ hasText: 'Subir campanha do cliente' });
  await expect(binned).toContainText('Mandado por você');
  await expect(binned).toContainText('sai de vez em');
  await shot(owner, 'lixeira');
  await binned.getByRole('button', { name: 'Restaurar Subir campanha do cliente' }).click();
  await expect(owner.getByText('A lixeira está vazia.')).toBeVisible();
  await expect(row(owner, 'Subir campanha do cliente').locator('.item-row')).toContainText(
    '1.499,90',
  );
  await owner.getByRole('button', { name: 'Lixeira' }).click();

  // Moved to another list, the item leaves this one; what only this list records waits for it.
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const traveller = row(owner, 'Subir campanha do cliente').locator('.item-panel');
  await traveller
    .getByLabel('Lista de destino de Subir campanha do cliente')
    .selectOption({ label: 'Operação › Dinheiro' });
  await traveller.getByRole('button', { name: 'Mover item' }).click();
  await expect(owner.locator('.item-rows').getByText('Subir campanha do cliente')).toHaveCount(0);
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Dinheiro' }).click();
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  await row(owner, 'Subir campanha do cliente')
    .getByLabel('Lista de destino de Subir campanha do cliente')
    .selectOption({ label: 'Operação › Tarefas' });
  await row(owner, 'Subir campanha do cliente').getByRole('button', { name: 'Mover item' }).click();
  await expect(owner.locator('.item-rows').getByText('Subir campanha do cliente')).toHaveCount(0);
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await expect(row(owner, 'Subir campanha do cliente').locator('.item-row')).toContainText(
    '1.499,90',
  );

  // Archiving a field hides it and what was filled in; restoring brings both back.
  await owner.getByRole('button', { name: 'Editar campos' }).click();
  await owner.getByRole('button', { name: 'Arquivar campo Painel' }).click();
  await expect(owner.getByRole('link', { name: 'https://exemplo.test/painel' })).toHaveCount(0);
  await owner.getByRole('button', { name: 'Restaurar Painel' }).click();
  await expect(owner.getByRole('link', { name: 'https://exemplo.test/painel' })).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar edição dos campos' }).click();
});

test('a sensitive list opens only after the code, each time the confirmation is no longer recent', async () => {
  await sql("UPDATE auth.sessions SET step_up_at = now() - interval '1 hour'");
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Dinheiro' }).click();
  await expect(owner.getByRole('heading', { name: /^Dinheiro/ })).toBeVisible();
  await expect(owner.getByText('Esta lista é sensível')).toBeVisible();
  await expect(owner.getByRole('region', { name: /^Etapa / })).toHaveCount(0);

  await owner.getByRole('button', { name: 'Confirmar código e abrir' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Código de 6 dígitos').fill(await authenticatorCode(ownerKey));
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(owner.getByRole('region', { name: 'Etapa A fazer' })).toBeVisible();

  // The employee was never given this list: for her it does not exist.
  const listAddress = new URL(owner.url()).pathname;
  await ana.goto(listAddress);
  await heading(ana, 'Lista não encontrada');
  await ana.goto('/');
});

test('work is handed to someone who can do it, and she finds it at once', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const item = owner.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const people = item.getByRole('group', { name: 'Responsáveis' });
  // Offered: who can work in this list. The owner, and Ana.
  await expect(people.getByRole('checkbox')).toHaveCount(2);
  await people.getByRole('checkbox', { name: 'Ana Souza' }).check();
  await people.getByRole('button', { name: 'Salvar responsáveis' }).click();
  await expect(item.locator('.item-row')).toContainText('Com Ana Souza');
  await shot(owner, 'responsaveis');

  // A field that names people offers the same people, and nobody else.
  await owner.getByRole('button', { name: 'Editar campos' }).click();
  await owner.getByLabel('Nome do novo campo').fill('Conferido por');
  await owner.getByLabel('Tipo do novo campo').selectOption({ label: 'Pessoas' });
  await owner.getByRole('button', { name: 'Adicionar campo' }).click();
  await expect(owner.getByRole('button', { name: 'Arquivar campo Conferido por' })).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar edição dos campos' }).click();
  // The item is still open: the new field is there to fill in.
  const checked = item.getByRole('group', { name: 'Conferido por' });
  await expect(checked.getByRole('checkbox')).toHaveCount(2);
  await checked.getByRole('checkbox', { name: 'Ana Souza' }).check();
  await item.getByRole('button', { name: 'Salvar item' }).click();
  await expect(
    item.getByRole('group', { name: 'Conferido por' }).getByRole('checkbox', { name: 'Ana Souza' }),
  ).toBeChecked();

  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await expect(
    ana.getByRole('button', { name: 'Subir campanha do cliente', exact: true }),
  ).toBeVisible();
  // She works on her items; handing out work is not hers to do.
  await ana.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  await expect(ana.getByRole('group', { name: 'Responsáveis' })).toHaveCount(0);
  // She reads who checked it, without being offered anyone to choose.
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await expect(hers.getByRole('group', { name: 'Conferido por' })).toHaveCount(0);
  await expect(hers.locator('.item-panel')).toContainText('Conferido por');
});

/** A one-pixel PNG: the smallest picture a browser will draw. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SCRIPT = 'Abertura, oferta, chamada.\n';

test('files go with the item: sent from the phone, shown in place, downloaded as they were', async () => {
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  const files = hers.locator('.subsection > .files > .file');
  await hers.getByLabel('Anexar arquivos a Subir campanha do cliente').setInputFiles([
    { name: 'briefing.png', mimeType: 'image/png', buffer: PIXEL },
    { name: 'roteiro.txt', mimeType: 'text/plain', buffer: Buffer.from(SCRIPT) },
  ]);
  const picture = files.filter({ hasText: 'briefing.png' });
  const script = files.filter({ hasText: 'roteiro.txt' });
  await expect(script.getByRole('button', { name: 'Baixar roteiro.txt' })).toBeVisible();
  // This installation runs without an antivirus, and every file says so.
  await expect(picture).toContainText('não verificado pelo antivírus');
  await picture.getByRole('button', { name: 'Ver briefing.png' }).click();
  const shown = picture.getByRole('img', { name: 'briefing.png' });
  await expect(shown).toBeVisible();
  await expect
    .poll(() => shown.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(1);
  // Text is never shown inside the page, only downloaded.
  await expect(script.getByRole('button', { name: /^(Ver|Tocar)/ })).toHaveCount(0);
  await shot(ana, 'anexos');

  // On the computer, the owner downloads it exactly as it was sent.
  await owner.reload();
  await heading(owner, 'Tarefas');
  const item = owner.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const [download] = await Promise.all([
    owner.waitForEvent('download'),
    item.getByRole('button', { name: 'Baixar roteiro.txt' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('roteiro.txt');
  expect(await readFile(await download.path(), 'utf8')).toBe(SCRIPT);

  // Ana removes one, finds it in the trash and brings it back.
  await script.getByRole('button', { name: 'Mandar para a lixeira o anexo roteiro.txt' }).click();
  await expect(script).toHaveCount(0);
  await hers.getByRole('button', { name: 'Ver anexos na lixeira' }).click();
  await hers.getByRole('button', { name: 'Restaurar o anexo roteiro.txt' }).click();
  await expect(script).toHaveCount(1);
  await expect(hers.getByText('Nenhum anexo na lixeira.')).toBeVisible();

  // The item's history tells all of it.
  await owner.reload();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  await item.getByRole('button', { name: 'Ver o que mudou neste item' }).click();
  const changes = item.locator('.changes');
  await expect(changes).toContainText('Ana Souza anexou “briefing.png”');
  await expect(changes).toContainText('Ana Souza mandou o anexo “roteiro.txt” para a lixeira');
  await expect(changes).toContainText('Ana Souza tirou o anexo “roteiro.txt” da lixeira');
});

const PANEL_PASSWORD = 'painel-de-teste-7 com espaço'; // gitleaks:allow (senha fictícia de teste)

test('a secret is kept sealed: filled in by who edits, revealed only by who may, after the code', async () => {
  await owner.getByRole('button', { name: 'Editar campos' }).click();
  await owner.getByLabel('Nome do novo campo').fill('Senha do painel');
  await owner.getByLabel('Tipo do novo campo').selectOption({ label: 'Secreto' });
  await owner.getByRole('button', { name: 'Adicionar campo' }).click();
  await expect(owner.getByRole('button', { name: 'Arquivar campo Senha do painel' })).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar edição dos campos' }).click();

  // Ana works on the item: she keeps the password there, and cannot read it back.
  await ana.reload();
  await heading(ana, 'Tarefas');
  await ana.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await hers.getByRole('button', { name: 'Preencher Senha do painel' }).click();
  await hers.getByLabel('Novo valor de Senha do painel').fill(PANEL_PASSWORD);
  await hers.getByRole('button', { name: 'Guardar Senha do painel' }).click();
  await expect(hers.getByText('Valor guardado, escondido')).toBeVisible();
  await expect(hers.getByRole('button', { name: /^Revelar/ })).toHaveCount(0);
  await expect(hers.getByRole('button', { name: /^Copiar/ })).toHaveCount(0);
  await expect(ana.locator('main')).not.toContainText(PANEL_PASSWORD);
  await shot(ana, 'campo-secreto');

  // The owner may reveal; with her confirmation no longer recent, the code comes first.
  await sql(
    "UPDATE auth.sessions SET step_up_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM app.users WHERE email = 'olivia@exemplo.test')",
  );
  await owner.reload();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const item = owner.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await item.getByRole('button', { name: 'Revelar Senha do painel' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Código de 6 dígitos').fill(await authenticatorCode(ownerKey));
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(item.locator('.secret-field .exact')).toHaveText(PANEL_PASSWORD);
  await shot(owner, 'campo-secreto-revelado');
  await item.getByRole('button', { name: 'Esconder Senha do painel' }).click();
  await expect(item.getByText('Valor guardado, escondido')).toBeVisible();

  // The history says it was kept, and nothing more.
  await item.getByRole('button', { name: 'Ver o que mudou neste item' }).click();
  await expect(item.locator('.changes')).toContainText(
    'Ana Souza guardou um valor em Senha do painel',
  );
  await expect(owner.locator('main')).not.toContainText(PANEL_PASSWORD);
});

test('a files field says which attachment is which', async () => {
  await owner.getByRole('button', { name: 'Editar campos' }).click();
  await owner.getByLabel('Nome do novo campo').fill('Roteiro aprovado');
  await owner.getByLabel('Tipo do novo campo').selectOption({ label: 'Arquivos' });
  await owner.getByRole('button', { name: 'Adicionar campo' }).click();
  await expect(
    owner.getByRole('button', { name: 'Arquivar campo Roteiro aprovado' }),
  ).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar edição dos campos' }).click();
  const item = owner.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  const chosen = item.getByRole('group', { name: 'Roteiro aprovado' });
  // Offered: the item's own attachments, and nothing else.
  await expect(chosen.getByRole('checkbox')).toHaveCount(2);
  await chosen.getByRole('checkbox', { name: 'roteiro.txt' }).check();
  await item.getByRole('button', { name: 'Salvar item' }).click();
  await expect(item.getByRole('button', { name: 'Salvar item' })).toBeDisabled();

  await ana.reload();
  await heading(ana, 'Tarefas');
  await ana.getByRole('button', { name: 'Subir campanha do cliente', exact: true }).click();
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Subir campanha do cliente' });
  await expect(
    hers
      .getByRole('group', { name: 'Roteiro aprovado' })
      .getByRole('checkbox', { name: 'roteiro.txt' }),
  ).toBeChecked();
});

test('whoever manages a space builds inside it, without being an owner', async () => {
  // Arranged: the owner's confirmation is recent, as it would be right after the last step.
  await sql(
    "UPDATE auth.sessions SET step_up_at = now() WHERE user_id = (SELECT id FROM app.users WHERE email = 'olivia@exemplo.test')",
  );
  await owner.getByRole('link', { name: 'Pessoas' }).click();
  await heading(owner, 'Pessoas');
  await owner
    .getByRole('row', { name: /Ana Souza/ })
    .getByRole('button', { name: 'Gerenciar' })
    .click();
  await owner
    .getByLabel('Área', { exact: true })
    .selectOption({ label: 'Espaço inteiro: Operação' });
  await owner.getByLabel('Nível', { exact: true }).selectOption({ label: 'Gerencia' });
  await owner.getByRole('button', { name: 'Liberar área' }).click();
  await expect(owner.getByRole('listitem').filter({ hasText: 'Gerencia, ' })).toContainText(
    'Operação',
  );

  await ana.goto('/');
  await heading(ana, 'Seus espaços');
  await ana.getByRole('button', { name: 'Adicionar lista ou pasta em Operação' }).click();
  await ana.getByLabel('Nome', { exact: true }).fill('Ideias');
  await ana.getByRole('button', { name: 'Criar lista' }).click();
  await expect(ana.locator('.rows').getByRole('link', { name: 'Ideias' })).toBeVisible();
  // She cannot create a space: that stays with the owners.
  await expect(ana.getByRole('button', { name: 'Criar espaço' })).toHaveCount(0);
  await shot(ana, 'gestora-cria-lista');
});

test('several items change at once; several to the trash asks for the code again', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner
    .getByRole('button', { name: /^Adicionar item em/ })
    .first()
    .click();
  const newTitle = owner.getByLabel(/^Novo item em/);
  for (const title of ['Lote A', 'Lote B']) {
    await newTitle.fill(title);
    await owner.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(owner.getByRole('button', { name: title, exact: true })).toBeVisible();
  }
  const pick = async (): Promise<void> => {
    await owner.getByLabel('Selecionar Lote A').check();
    await owner.getByLabel('Selecionar Lote B').check();
  };
  await pick();
  const bar = owner.getByRole('region', { name: 'Itens selecionados' });
  await expect(bar).toContainText('2 itens selecionados');
  await bar.getByLabel('Mover para a etapa').selectOption({ label: 'Feito' });
  await bar.getByRole('button', { name: 'Mover selecionados' }).click();
  const done = owner.getByRole('region', { name: 'Etapa Feito' });
  await expect(done.getByRole('button', { name: 'Lote A', exact: true })).toBeVisible();
  await expect(done.getByRole('button', { name: 'Lote B', exact: true })).toBeVisible();
  await pick();
  await bar.getByLabel('Passar para').selectOption({ label: 'Ana Souza' });
  await bar.getByRole('button', { name: 'Passar selecionados' }).click();
  for (const title of ['Lote A', 'Lote B']) {
    await expect(
      owner.locator('.item-rows > li').filter({ hasText: title }).locator('.item-row'),
    ).toContainText('Com Ana Souza');
  }

  await sql(
    "UPDATE auth.sessions SET step_up_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM app.users WHERE email = 'olivia@exemplo.test')",
  );
  await pick();
  await shot(owner, 'edicao-em-massa');
  await bar.getByRole('button', { name: 'Mandar selecionados para a lixeira' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Código de 6 dígitos').fill(await authenticatorCode(ownerKey));
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(owner.getByRole('button', { name: 'Lote A', exact: true })).toHaveCount(0);
  await expect(owner.getByRole('button', { name: 'Lote B', exact: true })).toHaveCount(0);
  await expect(bar).toHaveCount(0);
});

test('priority and due date show what is urgent and what is late, to whoever sees the item', async () => {
  const dayFrom = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, '0'))
      .join('-');
  };
  const short = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  const full = (day: string): string => `${short(day)}/${day.slice(0, 4)}`;
  const [yesterday, today, tomorrow] = [dayFrom(-1), dayFrom(0), dayFrom(1)];

  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const row = owner.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' });
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const panel = row.locator('.item-panel');
  const save = panel.getByRole('button', { name: 'Salvar item' });
  await panel.getByLabel('Prioridade').selectOption({ label: '1 · Urgente' });
  await panel.getByLabel('Prazo').fill(yesterday);
  // A start after the due date is explained before anything is sent.
  await panel.getByLabel('Começa em').fill(tomorrow);
  await expect(panel).toContainText('O prazo não pode vir antes do começo.');
  await expect(save).toBeDisabled();
  await panel.getByLabel('Começa em').fill('');
  await save.click();
  await expect(save).toBeDisabled();
  const marks = row.locator('.item-row .item-marks');
  await expect(marks).toContainText('1 · Urgente');
  await expect(marks).toContainText(`Atrasado desde ${short(yesterday)}`);

  // Only what is late.
  const tools = owner.getByRole('search', { name: 'Filtrar e ordenar' });
  await tools.getByLabel('Prazo').selectOption({ label: 'Atrasados' });
  await expect(owner.getByRole('button', { name: 'Conferir perfis', exact: true })).toBeVisible();
  await expect(
    owner.getByRole('button', { name: 'Subir campanha do cliente', exact: true }),
  ).toHaveCount(0);
  await shot(owner, 'prioridade-prazo');
  await tools.getByLabel('Prazo').selectOption({ label: 'Qualquer prazo' });

  await panel.getByLabel('Prazo').fill(today);
  await save.click();
  await expect(marks).toContainText('Vence hoje');
  await panel.getByRole('button', { name: 'Ver o que mudou neste item' }).click();
  await expect(panel).toContainText(`mudou o prazo de ${full(yesterday)} para ${full(today)}`);
  await expect(panel).toContainText('definiu a prioridade: 1 · Urgente');

  // The employee who created it sees the same marks on her phone.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' });
  await expect(hers.locator('.item-marks')).toContainText('1 · Urgente');
  await expect(hers.locator('.item-marks')).toContainText('Vence hoje');
  expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(ana, 'prioridade-prazo-celular');
});

test('subtasks hang from an item, fold under it, and follow their own rules', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const parentTitle = 'Subir campanha do cliente';
  const row = owner.locator('.item-rows > li').filter({ hasText: parentTitle }).first();
  await owner.getByRole('button', { name: parentTitle, exact: true }).click();
  const panel = row.locator('.item-panel').first();
  for (const title of ['Escrever os textos', 'Separar as imagens']) {
    await panel.getByLabel(`Nova subtarefa de ${parentTitle}`).fill(title);
    await panel.getByRole('button', { name: 'Adicionar subtarefa' }).click();
    await expect(panel.locator('.subtask-names')).toContainText(title);
  }
  // Folded under the parent, with how many are done.
  const lead = row.locator('.item-row').first();
  await expect(lead).toContainText('0/2 subtarefas concluídas');
  await expect(owner.getByRole('button', { name: 'Escrever os textos', exact: true })).toHaveCount(
    0,
  );
  await row.getByRole('button', { name: `Mostrar 2 subtarefas de ${parentTitle}` }).click();
  const nested = owner.getByRole('list', { name: `Subtarefas de ${parentTitle}` });
  await nested.getByLabel('Etapa de Escrever os textos').selectOption({ label: 'Feito' });
  await expect(lead).toContainText('1/2 subtarefas concluídas');
  await shot(owner, 'subtarefas');

  // The employee the parent is with does not see subtasks that are not hers.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await expect(ana.getByRole('button', { name: parentTitle, exact: true })).toBeVisible();
  await expect(ana.getByText('subtarefa', { exact: false })).toHaveCount(0);

  // Taken out, a subtask stands on its own; sent to the trash, it goes alone.
  await nested.getByRole('button', { name: 'Separar as imagens', exact: true }).click();
  await nested.getByRole('button', { name: `Tirar de dentro de “${parentTitle}”` }).click();
  await expect(lead).toContainText('1/1 subtarefa concluída');
  const loose = owner.locator('.item-rows > li').filter({ hasText: 'Separar as imagens' }).first();
  await owner.getByRole('button', { name: 'Separar as imagens', exact: true }).click();
  await loose.getByRole('button', { name: 'Mandar para a lixeira Separar as imagens' }).click();
  await expect(owner.getByRole('button', { name: 'Separar as imagens', exact: true })).toHaveCount(
    0,
  );
  await nested.getByRole('button', { name: 'Escrever os textos', exact: true }).click();
  await nested.getByRole('button', { name: 'Mandar para a lixeira Escrever os textos' }).click();
  await expect(lead).not.toContainText('subtarefa');
});

test('a checklist inside the item is ticked by whoever works on it', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const row = owner.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const panel = row.locator('.item-panel').first();
  for (const line of ['Separar as contas', 'Testar os acessos']) {
    await panel.getByLabel('Nova linha na checklist de Conferir perfis').fill(line);
    await panel.getByRole('button', { name: 'Pôr na checklist' }).click();
    await expect(panel.getByRole('checkbox', { name: line })).toBeVisible();
  }
  await panel.getByRole('checkbox', { name: 'Separar as contas' }).check();
  const marks = row.locator('.item-row .item-marks').first();
  await expect(marks).toContainText('Checklist 1/2');
  await shot(owner, 'checklist');

  // The employee whose item it is ticks the rest on her phone.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await expect(hers.locator('.item-marks').first()).toContainText('Checklist 1/2');
  await ana.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  await hers.getByRole('checkbox', { name: 'Testar os acessos' }).check();
  await expect(hers.locator('.item-marks').first()).toContainText('Checklist 2/2');
  await hers.getByRole('button', { name: 'Ver o que mudou neste item' }).click();
  await expect(hers.locator('.item-panel')).toContainText(
    'Você marcou como feito: “Testar os acessos”',
  );
  expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(ana, 'checklist-celular');
});

test('comments are a conversation on the item, with every change kept', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const row = (page: Page) =>
    page.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  await row(owner).getByLabel('Escrever um comentário').fill('Consegue conferir até sexta?');
  await row(owner).getByRole('button', { name: 'Comentar' }).click();
  await expect(row(owner).locator('.comments')).toContainText('Consegue conferir até sexta?');
  await expect(row(owner).locator('.item-row .item-marks').first()).toContainText('1 comentário');

  // The employee answers on her phone, then corrects herself.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await ana.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const hers = row(ana);
  await expect(hers.locator('.comments')).toContainText('Consegue conferir até sexta?');
  await hers.getByLabel('Escrever um comentário').fill('Confiro hoje.');
  await hers.getByRole('button', { name: 'Comentar' }).click();
  await hers.getByRole('button', { name: 'Editar o seu comentário' }).click();
  await hers.getByLabel('Mudar o comentário').fill('Confiro hoje à tarde.\nTe aviso aqui.');
  await hers.getByRole('button', { name: 'Salvar comentário' }).click();
  await expect(hers.locator('.comments')).toContainText('editado');
  // She cannot change or remove what the owner wrote.
  await expect(
    hers.getByRole('button', { name: 'Editar o comentário de Olívia Dona' }),
  ).toHaveCount(0);
  await expect(
    hers.getByRole('button', { name: 'Apagar o comentário de Olívia Dona' }),
  ).toHaveCount(0);
  expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(ana, 'comentarios-celular');

  // The owner reads what it said before, and, managing the list, removes it.
  await owner.reload();
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const answer = row(owner).locator('.comment').filter({ hasText: 'Confiro hoje à tarde.' });
  await answer.getByRole('button', { name: 'Ver versões anteriores' }).click();
  await expect(answer.locator('.comment-versions')).toContainText('Confiro hoje.');
  await shot(owner, 'comentarios');
  await answer.getByRole('button', { name: 'Apagar o comentário de Ana Souza' }).click();
  await expect(row(owner).locator('.comments')).toContainText(
    'Comentário de Ana Souza apagado por você',
  );
  await expect(row(owner).locator('.comments')).not.toContainText('Confiro hoje');
});

test('a comment mentions only people who see the item, and they see their name set apart', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const row = (page: Page) =>
    page.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const mine = row(owner);
  await mine.getByLabel('Escrever um comentário').fill('Pode fechar hoje,');
  // Offered: who sees the item, and not the one writing.
  const pick = mine.getByLabel('Mencionar alguém');
  await expect(pick.locator('option')).toHaveText(['Escolha a pessoa', 'Ana Souza']);
  await pick.selectOption({ label: 'Ana Souza' });
  await expect(mine.getByLabel('Escrever um comentário')).toHaveValue(
    'Pode fechar hoje, @Ana Souza ',
  );
  await mine.getByRole('button', { name: 'Comentar' }).click();
  const said = mine.locator('.comment').filter({ hasText: 'Pode fechar hoje' });
  await expect(said.locator('.mention')).toHaveText('@Ana Souza');
  await shot(owner, 'mencao');

  // She reads it with the owner's name, and her own set apart.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await ana.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const hers = row(ana).locator('.comment').filter({ hasText: 'Pode fechar hoje' });
  await expect(hers.locator('.comment-head')).toContainText('Olívia Dona');
  await expect(hers.locator('.mention')).toHaveText('@Ana Souza');
  // What the owner removed earlier reads as hers, removed by the owner.
  await expect(row(ana).locator('.comments')).toContainText(
    'Seu comentário foi apagado por Olívia Dona',
  );
  await shot(ana, 'mencao-celular');
});

test('notices tell her what concerns her, and lead to the item', async () => {
  await ana.goto('/');
  const notices = ana.getByRole('link', { name: /^Avisos/ });
  // Unread ones are counted in the header, on every page.
  await expect(notices).toHaveAccessibleName(/Avisos \d+ não lidos?/);
  await notices.click();
  await heading(ana, 'Avisos');
  const list = ana.locator('.notices');
  await expect(list).toContainText('Olívia Dona mencionou você em “Conferir perfis”');
  await expect(list).toContainText('Olívia Dona passou “Subir campanha do cliente” para você');
  expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(ana, 'avisos-celular');
  // Opening one marks it read and leads to the item.
  await list
    .getByRole('button', { name: /^Olívia Dona mencionou você em “Conferir perfis”/ })
    .first()
    .click();
  await heading(ana, 'Tarefas');
  await expect(ana.getByRole('button', { name: 'Conferir perfis', exact: true })).toBeVisible();
  await ana.getByRole('link', { name: /^Avisos/ }).click();
  await ana.getByRole('button', { name: 'Marcar todos como lidos' }).click();
  await expect(ana.getByRole('link', { name: /^Avisos/ })).toHaveAccessibleName('Avisos');
  await expect(ana.locator('.notice-item.is-unread')).toHaveCount(0);
});

test('what changes shows up on the other open page without reloading', async () => {
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  const hers = ana.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await expect(hers.locator('.item-marks').first()).toContainText('Checklist 2/2');

  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const row = owner.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' }).first();
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  await row.getByLabel('Nova linha na checklist de Conferir perfis').fill('Conferir senhas');
  await row.getByRole('button', { name: 'Pôr na checklist' }).click();
  // Her page, untouched, catches up by itself.
  await expect(hers.locator('.item-marks').first()).toContainText('Checklist 2/3');
  await shot(ana, 'tempo-real-celular');

  // And a comment for her raises her count of notices, also by itself.
  await row.getByLabel('Escrever um comentário').fill('Mais uma linha na checklist.');
  await row.getByRole('button', { name: 'Comentar' }).click();
  await expect(ana.getByRole('link', { name: /^Avisos/ })).toHaveAccessibleName(
    /Avisos 1 não lido/,
  );

  // Put back as it was, for what comes next.
  await row.getByRole('button', { name: 'Tirar da checklist: Conferir senhas' }).click();
  await expect(hers.locator('.item-marks').first()).toContainText('Checklist 2/2');
});

test('a recurring item comes back, a step later, when it is finished', async () => {
  const dayFrom = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, '0'))
      .join('-');
  };
  const short = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner
    .getByRole('button', { name: /^Adicionar item em/ })
    .first()
    .click();
  await owner.getByLabel(/^Novo item em/).fill('Pagar fornecedor');
  await owner.getByRole('button', { name: 'Adicionar', exact: true }).click();
  const rows = owner.locator('.item-rows > li').filter({ hasText: 'Pagar fornecedor' });
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: 'Pagar fornecedor', exact: true }).click();
  const panel = rows.first().locator('.item-panel');
  await panel.getByLabel('Prazo').fill(dayFrom(0));
  await panel.getByRole('button', { name: 'Salvar item' }).click();
  await expect(panel.getByRole('button', { name: 'Salvar item' })).toBeDisabled();
  await panel.getByLabel('Repetir').selectOption({ label: 'Toda semana' });
  await expect(rows.first().locator('.item-row .item-marks')).toContainText('Repete toda semana');

  // Finished, it comes back in the first stage, due a week later, still repeating.
  await rows.first().getByLabel('Etapa de Pagar fornecedor').selectOption({ label: 'Feito' });
  await expect(rows).toHaveCount(2);
  const next = rows.filter({ hasText: 'Repete toda semana' });
  await expect(next).toHaveCount(1);
  await expect(next.locator('.item-marks').first()).toContainText(`Prazo ${short(dayFrom(7))}`);
  await shot(owner, 'recorrencia');

  // Both go to the trash, one at a time, so the list is as it was.
  for (const left of [2, 1]) {
    await expect(rows).toHaveCount(left);
    const row = rows.first();
    if ((await row.locator('.item-panel').count()) === 0) {
      await row.getByRole('button', { name: 'Pagar fornecedor', exact: true }).click();
    }
    await row.getByRole('button', { name: 'Mandar para a lixeira Pagar fornecedor' }).click();
  }
  await expect(rows).toHaveCount(0);
});

test('a rule acts on its own, with its author’s access, and says it was the rule', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Automações', exact: true }).click();
  const rules = owner.getByRole('region', { name: 'Automações desta lista' });
  await expect(rules.getByText('Nenhuma regra ainda.')).toBeVisible();
  await rules.getByRole('button', { name: 'Criar regra' }).click();
  await rules.getByLabel('Nome da regra').fill('Feito vai para a Ana');
  await rules.getByLabel('Entra em').selectOption({ label: 'Feito' });
  await rules.getByLabel('Ação 1', { exact: true }).selectOption({ label: 'Passar para' });
  await rules.getByLabel('Valor da ação 1').selectOption({ label: 'Ana Souza' });
  await rules.getByRole('button', { name: 'Adicionar ação' }).click();
  await rules.getByLabel('Ação 2', { exact: true }).selectOption({ label: 'Comentar' });
  await rules.getByLabel('Texto do comentário da ação 2').fill('Ana, confira antes de fechar.');
  await rules.getByRole('button', { name: 'Salvar regra' }).click();
  await expect(rules.locator('.rule-sentence')).toHaveText(
    'Quando um item entra em Feito: passar para Ana Souza e comentar “Ana, confira antes de fechar.”.',
  );
  await expect(rules).toContainText('Age com o seu acesso. Ainda não agiu.');

  // The owner finishes an item; the rule hands it to Ana and comments, as itself.
  await owner
    .getByRole('button', { name: /^Adicionar item em/ })
    .first()
    .click();
  await owner.getByLabel(/^Novo item em/).fill('Fechar o caixa');
  await owner.getByRole('button', { name: 'Adicionar', exact: true }).click();
  const rows = owner.locator('.item-rows > li').filter({ hasText: 'Fechar o caixa' });
  await rows.first().getByLabel('Etapa de Fechar o caixa').selectOption({ label: 'Feito' });
  // The page catches up by itself with what the rule did.
  await expect(rows.first().locator('.item-row .item-marks')).toContainText('1 comentário');
  await expect(rows.first()).toContainText('Com Ana Souza');
  await rows.first().getByRole('button', { name: 'Fechar o caixa', exact: true }).click();
  const panel = rows.first().locator('.item-panel');
  await expect(panel.locator('.comment-head')).toContainText(
    'A automação “Feito vai para a Ana”com o seu acesso',
  );
  await expect(panel).toContainText('Ana, confira antes de fechar.');
  await rules.getByRole('button', { name: 'Ver o registro' }).click();
  await expect(rules.locator('.rule-runs')).toContainText('AgiuFechar o caixa');
  await shot(owner, 'automacoes');

  // Ana is told, by the rule's name.
  await ana.goto('/');
  await ana.getByRole('link', { name: /^Avisos/ }).click();
  await expect(
    ana.getByRole('button', {
      name: /^A automação “Feito vai para a Ana” passou “Fechar o caixa” para você/,
    }),
  ).toBeVisible();
  await shot(ana, 'automacao-aviso-celular');
  await ana.getByRole('button', { name: 'Marcar todos como lidos' }).click();

  // Paused, it no longer acts; removed, it is gone. The list is left as it was.
  await rules.getByRole('button', { name: 'Pausar' }).click();
  await expect(rules.locator('.rule.is-paused')).toContainText('Pausada');
  await rules.getByRole('button', { name: 'Apagar', exact: true }).click();
  await rules.getByRole('button', { name: 'Apagar “Feito vai para a Ana” de vez' }).click();
  await expect(rules.getByText('Nenhuma regra ainda.')).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar as automações' }).click();
  await rows.first().getByRole('button', { name: 'Mandar para a lixeira Fechar o caixa' }).click();
  await expect(rows).toHaveCount(0);
});

test('a rule started by a hand-over sets a due date, fills in a field and adds a subtask', async () => {
  const short = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  };
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Automações', exact: true }).click();
  const rules = owner.getByRole('region', { name: 'Automações desta lista' });
  await rules.getByRole('button', { name: 'Criar regra' }).click();
  await rules.getByLabel('Nome da regra').fill('Recebeu, tem prazo');
  await rules.getByLabel('O que faz a regra agir').selectOption({ label: 'Alguém recebe um item' });
  await rules.getByLabel('Ação 1', { exact: true }).selectOption({ label: 'Pôr prazo' });
  await rules.getByLabel('Valor da ação 1').selectOption({ label: 'Daqui a 7 dias' });
  await rules.getByRole('button', { name: 'Adicionar ação' }).click();
  await rules.getByLabel('Ação 2', { exact: true }).selectOption({ label: 'Preencher campo' });
  await rules.getByLabel('Campo da ação 2').selectOption({ label: 'Fornecedor' });
  await rules.getByLabel('Fornecedor', { exact: true }).selectOption({ label: 'Alfa' });
  await rules.getByRole('button', { name: 'Adicionar ação' }).click();
  await rules.getByLabel('Ação 3', { exact: true }).selectOption({ label: 'Criar subtarefa' });
  await rules.getByLabel('Título da subtarefa da ação 3').fill('Conferir a nota fiscal');
  await rules.getByRole('button', { name: 'Salvar regra' }).click();
  await expect(rules.locator('.rule-sentence')).toHaveText(
    'Quando alguém recebe um item: pôr o prazo para daqui a 7 dias, preencher Fornecedor com ' +
      '“Alfa” e criar a subtarefa “Conferir a nota fiscal”.',
  );
  await shot(owner, 'automacao-ao-receber');

  await owner
    .getByRole('button', { name: /^Adicionar item em/ })
    .first()
    .click();
  await owner.getByLabel(/^Novo item em/).fill('Pagar o aluguel');
  await owner.getByRole('button', { name: 'Adicionar', exact: true }).click();
  const rows = owner.locator('.item-rows > li').filter({ hasText: 'Pagar o aluguel' });
  await rows.first().getByRole('button', { name: 'Pagar o aluguel', exact: true }).click();
  const people = rows.first().getByRole('group', { name: 'Responsáveis' });
  await people.getByRole('checkbox', { name: 'Ana Souza' }).check();
  await people.getByRole('button', { name: 'Salvar responsáveis' }).click();
  const lead = rows.first().locator('.item-row').first();
  await expect(lead).toContainText(`Prazo ${short(7)}`);
  await expect(lead).toContainText('Alfa');
  await expect(lead).toContainText('0/1 subtarefa concluída');
  await shot(owner, 'automacao-ao-receber-item');

  // Removed, and the item with its subtask goes to the trash: the list is as it was.
  await rules.getByRole('button', { name: 'Apagar', exact: true }).click();
  await rules.getByRole('button', { name: 'Apagar “Recebeu, tem prazo” de vez' }).click();
  await expect(rules.getByText('Nenhuma regra ainda.')).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar as automações' }).click();
  await rows
    .first()
    .getByRole('button', { name: 'Mostrar 1 subtarefa de Pagar o aluguel' })
    .click();
  const nested = owner.getByRole('list', { name: 'Subtarefas de Pagar o aluguel' });
  await nested.getByRole('button', { name: 'Conferir a nota fiscal', exact: true }).click();
  await nested
    .getByRole('button', { name: 'Mandar para a lixeira Conferir a nota fiscal' })
    .click();
  await expect(lead).not.toContainText('subtarefa');
  await rows.first().getByRole('button', { name: 'Mandar para a lixeira Pagar o aluguel' }).click();
  await expect(rows).toHaveCount(0);
});

test('a stage can take items only from some roles up, and the page offers it only to them', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Editar etapas' }).click();
  const blocked = owner
    .locator('.stage-editor > li')
    .filter({ has: owner.getByRole('button', { name: 'Remover Bloqueado' }) });
  await blocked.getByLabel('Quem põe itens aqui').selectOption({ label: 'ADMs ou acima' });
  await blocked.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(blocked.getByRole('button', { name: 'Salvar etapa' })).toBeDisabled();
  await shot(owner, 'etapa-restrita');

  // Ana works on her item, but cannot put it in Bloqueado; the owner still can.
  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  const hers = ana.getByLabel('Etapa de Conferir perfis').first();
  await expect(hers.locator('option', { hasText: 'Bloqueado' })).toBeDisabled();
  await expect(hers.locator('option', { hasText: 'Feito' })).toBeEnabled();
  await shot(ana, 'etapa-restrita-celular');
  const ownerSelect = owner.getByLabel('Etapa de Conferir perfis').first();
  await expect(ownerSelect.locator('option', { hasText: 'Bloqueado' })).toBeEnabled();

  // Back as it was, for what comes next.
  await blocked.getByLabel('Quem põe itens aqui').selectOption({ label: 'Quem edita o item' });
  await blocked.getByRole('button', { name: 'Salvar etapa' }).click();
  await expect(blocked.getByRole('button', { name: 'Salvar etapa' })).toBeDisabled();
  await owner.getByRole('button', { name: 'Fechar edição das etapas' }).click();
});

test('a rule can wait for the due date', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByRole('button', { name: 'Automações', exact: true }).click();
  const rules = owner.getByRole('region', { name: 'Automações desta lista' });
  await rules.getByRole('button', { name: 'Criar regra' }).click();
  await rules.getByLabel('Nome da regra').fill('Véspera do prazo');
  await rules
    .getByLabel('O que faz a regra agir')
    .selectOption({ label: 'O prazo de um item chega' });
  await rules
    .getByLabel('Quando', { exact: true })
    .selectOption({ label: 'falta 1 dia para o prazo' });
  await rules.getByLabel('Ação 1', { exact: true }).selectOption({ label: 'Mudar a prioridade' });
  await rules.getByLabel('Valor da ação 1').selectOption({ label: 'Urgente' });
  await rules.getByRole('button', { name: 'Adicionar ação' }).click();
  await rules.getByLabel('Ação 2', { exact: true }).selectOption({ label: 'Avisar' });
  await rules.getByRole('group', { name: 'Quem avisar na ação 2' }).getByLabel('Ana Souza').check();
  await rules.getByRole('button', { name: 'Salvar regra' }).click();
  await expect(rules.locator('.rule-sentence')).toHaveText(
    'Quando falta 1 dia para o prazo: mudar a prioridade para Urgente e avisar Ana Souza.',
  );
  await shot(owner, 'automacao-prazo');
  await rules.getByRole('button', { name: 'Apagar', exact: true }).click();
  await rules.getByRole('button', { name: 'Apagar “Véspera do prazo” de vez' }).click();
  await expect(rules.getByText('Nenhuma regra ainda.')).toBeVisible();
  await owner.getByRole('button', { name: 'Fechar as automações' }).click();
});

test('the numbers of a list count what each person sees', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByRole('link', { name: 'Painel', exact: true }).click();
  const tiles = owner.locator('.summary-tiles');
  await expect(tiles.locator('div').filter({ hasText: 'Itens' }).locator('dd')).toHaveText('2');
  const stages = owner.getByRole('region', { name: 'Por etapa' });
  await expect(stages.getByRole('row', { name: /^Fazendo/ })).toContainText('100%');
  await expect(owner.getByRole('region', { name: 'Com quem' })).toContainText('Ana Souza');
  await expect(owner.getByRole('region', { name: 'Por Fornecedor' })).toContainText('Alfa');
  await shot(owner, 'painel-da-lista');

  await ana.goto('/');
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await ana.getByRole('link', { name: 'Painel', exact: true }).click();
  await expect(ana.getByText('Os números contam só os itens que são seus.')).toBeVisible();
  await expect(ana.getByRole('region', { name: 'Com quem' })).not.toContainText('Olívia Dona');
  await shot(ana, 'painel-da-lista-celular');
  await ana.getByRole('link', { name: 'Lista', exact: true }).click();
  await owner.getByRole('link', { name: 'Lista', exact: true }).click();
});

test('each person starts from their own page: their items by due date and the panels they pin', async () => {
  await owner.getByRole('link', { name: 'Início' }).click();
  await heading(owner, 'Início');
  const panels = owner.getByRole('region', { name: 'Painéis' });
  await expect(panels.getByText(/Fixe aqui as listas que você acompanha/)).toBeVisible();
  const choose = panels.getByLabel('Fixar o painel de uma lista');
  await choose.selectOption({ label: 'Operação / Tarefas' });
  await panels.getByRole('button', { name: 'Fixar', exact: true }).click();
  await choose.selectOption({ label: 'Operação / Dinheiro' });
  await panels.getByRole('button', { name: 'Fixar', exact: true }).click();
  const names = panels.locator('.home-panel h3 a');
  await expect(names).toHaveText(['Tarefas', 'Dinheiro']);
  await panels.getByRole('button', { name: 'Subir Dinheiro' }).click();
  await expect(names).toHaveText(['Dinheiro', 'Tarefas']);
  await panels.getByRole('button', { name: 'Tirar Dinheiro do início' }).click();
  await expect(names).toHaveText(['Tarefas']);
  const tiles = panels.locator('.summary-tiles');
  await expect(tiles.locator('div').filter({ hasText: 'Itens' }).locator('dd')).toHaveText('2');
  await expect(panels.getByRole('region', { name: 'Por etapa' })).toContainText('Fazendo');
  // The order is kept by the server, not by this page.
  await owner.reload();
  await expect(names).toHaveText(['Tarefas']);
  await shot(owner, 'inicio');

  await ana.getByRole('link', { name: 'Início' }).click();
  await heading(ana, 'Início');
  const mine = ana.getByRole('region', { name: 'Com você' });
  await expect(mine).toContainText('Subir campanha do cliente');
  await expect(mine).toContainText('Conferir perfis');
  await expect(mine.locator('.row-detail').first()).toContainText('Tarefas, em ');
  expect(await ana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(ana, 'inicio-celular');
});

test('the weekly report counts each list and each person, against the week before', async () => {
  // The routine writes last week's report at the start; this week's is written here, so
  // far, and the code is stale so the sensitive lists stay out until it is confirmed.
  await sql("SELECT app.weekly_report_make(date_trunc('week', current_date)::date)");
  await sql(
    "UPDATE auth.sessions SET step_up_at = step_up_at - interval '2 hours' WHERE step_up_at IS NOT NULL",
  );
  await owner.getByRole('link', { name: 'Relatórios' }).click();
  await heading(owner, 'Relatório da semana');
  await expect(owner.getByRole('button', { name: 'Incluir as listas sensíveis' })).toBeVisible();
  const lists = owner.getByRole('region', { name: 'Por lista' });
  const tarefas = lists.getByRole('row', { name: /^Tarefas/ });
  await expect(tarefas.getByRole('cell')).toHaveText(['2', '0', '2', '0']);
  await expect(lists.getByRole('row', { name: /^Dinheiro/ })).toHaveCount(0);
  await expect(owner.getByRole('region', { name: 'Por pessoa' })).toContainText('Ana Souza');
  await expect(owner.locator('.report-change').first()).toContainText(
    'em relação à semana anterior',
  );
  await shot(owner, 'relatorio-semanal');
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(owner, 'relatorio-semanal-celular');
  await owner.setViewportSize({ width: 1280, height: 900 });

  // Without the capability there is no report to open.
  await expect(ana.getByRole('link', { name: 'Relatórios' })).toHaveCount(0);
  await sql(
    "UPDATE auth.sessions SET step_up_at = step_up_at + interval '2 hours' WHERE step_up_at IS NOT NULL",
  );
});

test('the app can be installed, and its worker keeps the page and never anything from the API', async () => {
  await owner.getByRole('link', { name: 'Início' }).click();
  await heading(owner, 'Início');
  const manifest = await owner.evaluate(() =>
    fetch('/manifest.webmanifest').then((response) => response.json() as Promise<{ name: string }>),
  );
  expect(manifest.name).toBe('Empresa Exemplo');
  // The worker keeps the page and its files, and nothing from the API.
  await owner.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const kept = await owner.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        paths.push(new URL(request.url).pathname);
      }
    }
    return paths;
  });
  expect(kept).toContain('/index.html');
  expect(kept.filter((path) => path !== '/index.html' && !path.startsWith('/assets/'))).toEqual([]);

  // Without a connection the page still opens; what this device kept is shown, and says so.
  const before = problems.length;
  await ownerContext.setOffline(true);
  await owner.reload();
  await heading(owner, 'Início');
  await expect(owner.getByText(/Você está vendo o que este aparelho guardou em/)).toBeVisible();
  await ownerContext.setOffline(false);
  await owner.reload();
  await heading(owner, 'Início');
  expect(
    problems.splice(before).filter((problem) => !/ERR_INTERNET_DISCONNECTED/.test(problem)),
  ).toEqual([]);
});

test('a phone keeps the lists it opened, sealed, to read and change offline', async () => {
  await ana.getByRole('link', { name: 'Espaços' }).click();
  await ana.getByRole('link', { name: 'Tarefas' }).click();
  await heading(ana, 'Tarefas');
  await expect(ana.getByText('Conferir perfis').first()).toBeVisible();
  const listId = new URL(ana.url()).pathname.split('/')[2] ?? '';
  // What the device kept: the list, and nothing readable without the key.
  const kept = async (): Promise<{ slots: string[]; readable: boolean }> =>
    ana.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('cerebro-offline');
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('no database'));
        };
      });
      const store = db.transaction('records', 'readonly').objectStore('records');
      const slots = await new Promise<string[]>((resolve) => {
        const request = store.getAllKeys();
        request.onsuccess = () => {
          resolve(request.result.map(String));
        };
      });
      const values = await new Promise<{ data: ArrayBuffer }[]>((resolve) => {
        const request = db.transaction('records', 'readonly').objectStore('records').getAll();
        request.onsuccess = () => {
          resolve(request.result as { data: ArrayBuffer }[]);
        };
      });
      db.close();
      const plain = values.map((value) => new TextDecoder().decode(value.data)).join(' ');
      return { slots, readable: /Conferir perfis|Ana Souza|Tarefas/.test(plain) };
    });
  await expect
    .poll(async () => (await kept()).slots.sort())
    .toEqual(
      [
        '/api/home',
        '/api/me',
        '/api/tree',
        `/api/lists/${listId}/items`,
        `/api/lists/${listId}/stages`,
        `/api/lists/${listId}/fields`,
      ].sort(),
    );
  expect((await kept()).readable).toBe(false);

  // Offline, the list opens from the device and says where it comes from.
  const before = problems.length;
  await anaContext.setOffline(true);
  await ana.reload();
  await heading(ana, 'Tarefas');
  await expect(ana.getByText('Conferir perfis').first()).toBeVisible();
  await expect(ana.getByText(/Você está vendo o que este aparelho guardou em/)).toBeVisible();
  await shot(ana, 'offline-lista-celular');

  // Changes made offline wait on the phone, and the list already reads with them.
  await ana.getByLabel('Etapa de Conferir perfis').first().selectOption({ label: 'Feito' });
  await ana
    .getByLabel('Etapa de Subir campanha do cliente')
    .first()
    .selectOption({ label: 'Bloqueado' });
  const changes = ana.getByRole('region', { name: 'Mudanças feitas sem conexão' });
  await expect(changes).toContainText('2 mudanças feitas sem conexão esperam para ser enviadas.');
  await expect(ana.getByLabel('Etapa de Conferir perfis').first()).toHaveValue(
    (await ana
      .getByLabel('Etapa de Conferir perfis')
      .first()
      .locator('option', { hasText: 'Feito' })
      .getAttribute('value')) ?? '',
  );
  await shot(ana, 'offline-mudancas-celular');

  // Meanwhile the owner, online, moves one of the same items somewhere else.
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner.getByLabel('Etapa de Conferir perfis').first().selectOption({ label: 'Bloqueado' });

  // Back online: what nobody else touched goes through; the other one asks her to decide.
  await anaContext.setOffline(false);
  await expect(changes).toContainText(
    'Enquanto você estava sem conexão, alguém mudou “Conferir perfis”: na etapa, a sua é Feito e a de lá é Bloqueado.',
  );
  await expect(changes).not.toContainText(/espera/);
  await expect(ana.getByText(/Você está vendo o que este aparelho guardou/)).toHaveCount(0);
  await shot(ana, 'offline-conflito-celular');
  await changes.getByRole('button', { name: 'Manter a minha' }).click();
  await expect(changes).toHaveCount(0);
  await expect(ana.getByText(/Você está vendo o que este aparelho guardou/)).toHaveCount(0);
  await owner.reload();
  const stageOf = async (title: string): Promise<string | null> => {
    const select = owner.getByLabel(`Etapa de ${title}`).first();
    const value = await select.inputValue();
    return select.locator(`option[value="${value}"]`).textContent();
  };
  expect(await stageOf('Conferir perfis')).toBe('Feito');
  expect(await stageOf('Subir campanha do cliente')).toBe('Bloqueado');
  // Back as it was, for what comes next.
  await owner.getByLabel('Etapa de Conferir perfis').first().selectOption({ label: 'Fazendo' });
  await owner
    .getByLabel('Etapa de Subir campanha do cliente')
    .first()
    .selectOption({ label: 'Fazendo' });
  await expect.poll(() => stageOf('Subir campanha do cliente')).toBe('Fazendo');
  expect(
    problems.splice(before).filter((problem) => !/ERR_INTERNET_DISCONNECTED/.test(problem)),
  ).toEqual([]);
});

test('the owner updates from the app: looks for a version, confirms the code, follows each step', async () => {
  await owner.getByRole('link', { name: 'Atualizações' }).click();
  await heading(owner, 'Atualizações');
  await expect(owner.getByText(/Versão em uso: 1\.4\.0\./)).toBeVisible();
  await owner.getByRole('button', { name: 'Procurar atualização' }).click();
  await heading(owner, 'Versão 1.5.0 disponível');
  await expect(owner.getByText('Correções na tela inicial.', { exact: false })).toBeVisible();
  await shot(owner, 'atualizacao-disponivel');

  // Updating asks for the code again, whatever the state of the session.
  await sql(
    "UPDATE auth.sessions SET step_up_at = step_up_at - interval '2 hours' WHERE step_up_at IS NOT NULL",
  );
  await owner.getByRole('button', { name: 'Atualizar agora' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Código de 6 dígitos').fill(await authenticatorCode(ownerKey));
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  const progress = owner.getByRole('region', { name: 'Andamento da atualização' });
  await expect(progress).toContainText('Atualizando para 1.5.0');
  await shot(owner, 'atualizacao-andamento');
  await expect(progress).toContainText('Atualizado para 1.5.0', { timeout: 40_000 });
  await expect(owner.getByText(/Versão em uso: 1\.5\.0\./)).toBeVisible();
  await shot(owner, 'atualizacao-concluida');

  // Nobody but owners sees updates.
  await expect(ana.getByRole('link', { name: 'Atualizações' })).toHaveCount(0);
});

test('everything is on the record, and the record is intact', async () => {
  await owner.getByRole('link', { name: 'Segurança' }).click();
  await heading(owner, 'Segurança');
  await owner.getByRole('button', { name: 'Verificar se o registro está íntegro' }).click();
  await expect(owner.getByText(/Registro íntegro: \d+ entradas conferidas/)).toBeVisible();
  const record = owner.locator('main');
  // The record shows the latest entries first; older ones come a page at a time.
  const older = owner.getByRole('button', { name: 'Carregar entradas mais antigas' });
  while (await older.isVisible()) {
    const shown = await record.locator('tbody tr').count();
    await older.click();
    await expect(record.locator('tbody tr')).not.toHaveCount(shown);
  }
  for (const entry of [
    'Instalação concluída',
    'Automação criada',
    'Pessoa convidada',
    'Link de acesso usado',
    'Aparelho novo pediu aprovação',
    'Aparelho aprovado',
    'Acesso concedido',
    'Lista sensível aberta',
    'Valor secreto revelado',
    'Vários itens mandados para a lixeira de uma vez',
    'Atualização pedida',
    'Atualização aplicada',
  ]) {
    await expect(record, entry).toContainText(entry);
  }
  await expect(record).toContainText('Ana Souza');
  await expect(record).toContainText('Olívia Dona');
});

test('suspending her throws her out at once and keeps her out', async () => {
  await owner.getByRole('link', { name: 'Pessoas' }).click();
  await heading(owner, 'Pessoas');
  await owner
    .getByRole('row', { name: /Ana Souza/ })
    .getByRole('button', { name: 'Gerenciar' })
    .click();
  await owner.getByRole('button', { name: 'Suspender conta' }).click();
  await expect(owner.getByText('Conta suspensa.')).toBeVisible();

  // On her phone's next contact the server turns it away, and what it kept is erased.
  const keptOnPhone = (): Promise<boolean> =>
    ana.evaluate(async () =>
      (await indexedDB.databases()).some((db) => db.name === 'cerebro-offline'),
    );
  expect(await keptOnPhone()).toBe(true);
  await ana.reload();
  await heading(ana, 'Entrar');
  await expect.poll(keptOnPhone).toBe(false);
  // Offline now, there is nothing to open: the page says so and waits for the connection.
  const before = problems.length;
  await anaContext.setOffline(true);
  await ana.reload();
  await expect(ana.getByText('Sem conexão com o servidor.', { exact: false })).toBeVisible();
  await shot(ana, 'sem-conexao-celular');
  await anaContext.setOffline(false);
  await heading(ana, 'Entrar');
  expect(
    problems.splice(before).filter((problem) => !/ERR_INTERNET_DISCONNECTED/.test(problem)),
  ).toEqual([]);

  await signIn(ana, 'ana@exemplo.test', PASSWORD);
  // The answer does not even confirm that the account exists.
  await expect(ana.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
});

test('stages come from a ready-made set, another list or a saved file, and leave as a file', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Dinheiro' }).click();
  await owner.getByRole('button', { name: 'Editar etapas' }).click();

  // Saved as a file: the browser receives it, and it reads as the list's stages.
  const [saved] = await Promise.all([
    owner.waitForEvent('download'),
    owner.getByRole('button', { name: 'Exportar estas etapas' }).click(),
  ]);
  expect(saved.suggestedFilename()).toBe('etapas-dinheiro.json');
  const savedPath = await saved.path();
  const exported = JSON.parse(await readFile(savedPath, 'utf8')) as {
    kind: string;
    stages: { name: string }[];
  };
  expect(exported.kind).toBe('cerebro.stages');
  expect(exported.stages.map((stage) => stage.name)).toEqual(['A fazer', 'Fazendo', 'Feito']);

  // A ready-made set adds what is missing and removes nothing.
  await owner.getByLabel('Modelo de etapas').selectOption({ label: 'Modelo pronto: Clientes' });
  await owner.getByRole('button', { name: 'Aplicar modelo' }).click();
  await expect(owner.getByText('Modelo Clientes: etapas aplicadas.')).toBeVisible();
  await expect(owner.getByRole('region', { name: 'Etapa Contato' })).toBeVisible();
  await expect(owner.getByRole('region', { name: 'Etapa A fazer' })).toBeVisible();

  // A file that is not a set of stages is refused before anything is sent.
  await owner.getByLabel('Importar etapas de um arquivo').setInputFiles({
    name: 'qualquer.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"kind":"outra.coisa"}'),
  });
  await expect(owner.getByText(/não é um conjunto de etapas exportado/)).toBeVisible();
  // The saved file goes back in.
  await owner.getByLabel('Importar etapas de um arquivo').setInputFiles(savedPath);
  await expect(owner.getByText('Arquivo "Dinheiro": etapas aplicadas.')).toBeVisible();
  await shot(owner, 'modelos-de-etapas');
  await owner.getByRole('button', { name: 'Fechar edição das etapas' }).click();
});

test('the owner changes her own password, and sees where she is signed in', async () => {
  await owner.getByRole('link', { name: 'Olívia Dona' }).click();
  await heading(owner, 'Minha conta');
  const sessions = owner.getByRole('region', { name: 'Onde você está conectado' });
  await expect(sessions).toContainText('esta sessão');

  await owner.getByLabel('Senha atual').fill(PASSWORD);
  await owner.getByLabel('Nova senha').fill('12345678');
  await expect(owner.getByRole('button', { name: 'Trocar senha' })).toBeDisabled();
  await owner.getByLabel('Nova senha').fill(`${PASSWORD}-nova`);
  await owner
    .getByLabel('Código do aplicativo autenticador')
    .fill(await authenticatorCode(ownerKey));
  await owner.getByRole('button', { name: 'Trocar senha' }).click();
  await expect(owner.getByText(/^Senha trocada\./)).toBeVisible();
  await shot(owner, 'minha-conta');
  // Still signed in here.
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await heading(owner, 'Seus espaços');
});

test('a list is narrowed and ordered, stays that way across a reload and the board, and is saved by name', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const tools = owner.getByRole('search', { name: 'Filtrar e ordenar' });
  const titles = owner.locator('.item-rows .item-title');
  await expect(titles).toHaveCount(2);

  await tools.getByLabel('Buscar no título').fill('PERFIS');
  await expect(titles).toHaveText(['Conferir perfis']);
  await expect(tools.getByRole('status')).toHaveText('Mostrando 1 de 2 itens.');
  // In the address: a reload keeps it, and so does the board.
  await owner.reload();
  await expect(tools.getByLabel('Buscar no título')).toHaveValue('PERFIS');
  await expect(titles).toHaveText(['Conferir perfis']);
  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Quadro' })
    .click();
  await expect(owner.locator('.card .card-title')).toHaveText(['Conferir perfis']);
  // Saved under a name, it comes back in one tap; it is hers alone.
  await owner.getByRole('button', { name: 'Salvar esta visão' }).click();
  await owner.getByLabel('Nome da visão').fill('Perfis no quadro');
  await owner.getByRole('button', { name: 'Salvar visão' }).click();
  const saved = owner.getByRole('navigation', { name: 'Suas visões salvas' });
  await expect(saved.getByRole('button', { name: /Perfis no quadro/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Lista' })
    .click();

  // By a field, typed the way amounts are written here, and ordered by it.
  await tools.getByLabel('Buscar no título').fill('');
  await tools.getByLabel('Filtrar por campo').selectOption({ label: 'Valor' });
  await tools.getByLabel('Condição de Valor').selectOption({ label: 'pelo menos' });
  await tools.getByLabel('Valor de Valor').fill('1.000,00');
  await expect(titles).toHaveText(['Subir campanha do cliente']);
  await tools.getByLabel('Filtrar por campo').selectOption({ label: 'Nenhum campo' });
  await tools.getByLabel('Ordenar por').selectOption({ label: 'Valor' });
  await tools.getByRole('button', { name: 'Ordem crescente' }).click();
  await expect(titles).toHaveText(['Subir campanha do cliente', 'Conferir perfis']);
  await shot(owner, 'filtros');
  await tools.getByRole('button', { name: 'Limpar filtros e ordem' }).click();
  await expect(titles).toHaveCount(2);
  expect(new URL(owner.url()).search).toBe('');

  // Gathered by someone other than the stage: a person, or a field's options.
  await tools.getByLabel('Agrupar por').selectOption({ label: 'Responsável' });
  await expect(
    owner.getByRole('region', { name: 'Grupo Ana Souza' }).locator('.item-title'),
  ).toHaveCount(2);
  await tools.getByLabel('Agrupar por').selectOption({ label: 'Fornecedor' });
  await expect(owner.getByRole('region', { name: 'Grupo Alfa' })).toContainText('Conferir perfis');
  await expect(owner.getByRole('region', { name: 'Grupo Beta' })).toContainText(
    'Subir campanha do cliente',
  );
  await shot(owner, 'agrupado');
  await tools.getByLabel('Agrupar por').selectOption({ label: 'Etapa' });
  expect(new URL(owner.url()).search).toBe('');

  await saved.getByRole('button', { name: /Perfis no quadro/ }).click();
  await expect(owner.locator('.card .card-title')).toHaveText(['Conferir perfis']);
  expect(new URL(owner.url()).pathname).toMatch(/\/quadro$/);
  await expect(tools.getByLabel('Buscar no título')).toHaveValue('PERFIS');
  await shot(owner, 'visao-salva');
  await owner.getByRole('button', { name: 'Apagar a visão “Perfis no quadro”' }).click();
  await expect(saved).toHaveCount(0);
  await tools.getByRole('button', { name: 'Limpar filtros e ordem' }).click();
});

test('the calendar puts each item on its day, and becomes an agenda on a phone', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  await owner.getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const row = owner.locator('.item-rows > li').filter({ hasText: 'Conferir perfis' });
  await row.getByLabel('Data de compra').fill(today);
  await row.getByRole('button', { name: 'Salvar item' }).click();
  await expect(row.getByRole('button', { name: 'Salvar item' })).toBeDisabled();

  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Calendário' })
    .click();
  const todayCell = owner.locator('.calendar-day.is-today');
  await expect(todayCell.getByRole('button', { name: 'Conferir perfis' })).toBeVisible();
  await shot(owner, 'calendario');
  await todayCell.getByRole('button', { name: 'Conferir perfis' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Conferir perfis' });
  await expect(dialog.getByLabel('Data de compra')).toHaveValue(today);
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).first().click();

  await owner.getByRole('button', { name: 'Próximo mês' }).click();
  await expect(owner.locator('.calendar-day.is-today')).toHaveCount(0);
  await owner.getByRole('button', { name: 'Voltar para hoje' }).click();
  await expect(todayCell.getByRole('button', { name: 'Conferir perfis' })).toBeVisible();

  // On a phone: only the days that have something, each named in full.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.locator('.calendar-head')).toBeHidden();
  await expect(todayCell.locator('.calendar-day-name')).toContainText('hoje');
  await expect(owner.locator('.calendar-day.is-empty').first()).toBeHidden();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(owner, 'calendario-celular');
  await owner.setViewportSize({ width: 1280, height: 900 });
});

test('the table shows the columns each person chooses, sorted by a click', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Tabela' })
    .click();
  const table = owner.getByRole('table');
  const rowTitles = table.locator('tbody th[scope="row"]');
  await expect(rowTitles).toHaveCount(2);
  await expect(table.getByRole('columnheader', { name: 'Fornecedor' })).toBeVisible();

  await table.getByRole('button', { name: 'Valor' }).click();
  await expect(table.getByRole('columnheader', { name: /Valor/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(rowTitles).toHaveText(['Conferir perfis', 'Subir campanha do cliente']);
  await table.getByRole('button', { name: /Valor/ }).click();
  await expect(rowTitles).toHaveText(['Subir campanha do cliente', 'Conferir perfis']);

  // Columns are chosen, and the choice is in the address.
  await owner.getByText('Escolher colunas').click();
  await owner.getByRole('checkbox', { name: 'Fornecedor' }).uncheck();
  await owner.getByRole('checkbox', { name: 'Criado em' }).check();
  await expect(table.getByRole('columnheader', { name: 'Fornecedor' })).toHaveCount(0);
  await owner.reload();
  await expect(
    owner.getByRole('table').getByRole('columnheader', { name: 'Criado em' }),
  ).toBeVisible();
  await expect(
    owner.getByRole('table').getByRole('columnheader', { name: 'Fornecedor' }),
  ).toHaveCount(0);
  await shot(owner, 'tabela');

  // A row opens the item; the stage changes right in the table.
  await rowTitles.getByRole('button', { name: 'Conferir perfis' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Conferir perfis' });
  await expect(dialog.getByLabel('Título')).toHaveValue('Conferir perfis');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).first().click();
  await owner.getByLabel('Etapa de Conferir perfis').selectOption({ label: 'Feito' });
  await expect(owner.getByLabel('Etapa de Conferir perfis')).toHaveValue(/.+/);
  await owner.getByLabel('Etapa de Conferir perfis').selectOption({ label: 'Fazendo' });

  // On a phone the table scrolls sideways inside itself, never the page.
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await owner.setViewportSize({ width: 1280, height: 900 });
});

test('the timeline shows each item as a bar on its days', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Linha do tempo' })
    .click();
  const timeline = owner.getByRole('table', { name: 'Linha do tempo' });
  const row = timeline.getByRole('row').filter({ hasText: 'Conferir perfis' });
  await expect(row.locator('.timeline-bar')).toBeVisible();
  await shot(owner, 'linha-do-tempo');
  await row.locator('.timeline-bar').click();
  const dialog = owner.getByRole('dialog', { name: 'Conferir perfis' });
  await expect(dialog.getByLabel('Título')).toHaveValue('Conferir perfis');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).first().click();

  await owner.getByRole('button', { name: 'Próximas semanas' }).click();
  await expect(row).toContainText('fora destas semanas');
  await owner.getByRole('button', { name: 'Voltar para hoje' }).click();
  await expect(row.locator('.timeline-bar')).toBeVisible();

  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await owner.setViewportSize({ width: 1280, height: 900 });
});

test('the search finds items in every list the person can open, and leads to them', async () => {
  const box = owner.getByRole('searchbox', { name: 'Buscar em todas as listas' });
  await box.fill('PERFIS');
  await box.press('Enter');
  await heading(owner, 'Busca');
  const results = owner.locator('.search-results');
  await expect(results.getByRole('link', { name: 'Conferir perfis' })).toBeVisible();
  await expect(results).toContainText('Tarefas');
  await shot(owner, 'busca');
  await results.getByRole('link', { name: 'Conferir perfis' }).click();
  await heading(owner, 'Tarefas');
  await expect(owner.locator('.item-rows .item-title')).toHaveText(['Conferir perfis']);
});

test('the board shows the list by stage, and a card is dragged from one to another', async () => {
  await owner.getByRole('link', { name: 'Espaços' }).click();
  await owner.getByRole('link', { name: 'Tarefas' }).click();
  await heading(owner, 'Tarefas');
  await owner
    .getByRole('navigation', { name: 'Ver como' })
    .getByRole('link', { name: 'Quadro' })
    .click();
  const column = (name: string) => owner.getByRole('region', { name: `Etapa ${name}` });
  const cardIn = (name: string) =>
    column(name).locator('.card').filter({ hasText: 'Conferir perfis' });
  await expect(cardIn('Fazendo')).toBeVisible();

  // Taken by its handle and dropped on the next column, which lights up on the way.
  await cardIn('Fazendo').locator('.card-handle').scrollIntoViewIfNeeded();
  const handle = await cardIn('Fazendo').locator('.card-handle').boundingBox();
  const target = await column('Feito').boundingBox();
  if (!handle || !target) throw new Error('the board is not laid out');
  const y = handle.y + handle.height / 2;
  await owner.mouse.move(handle.x + handle.width / 2, y);
  await owner.mouse.down();
  // Straight across: a column takes a card anywhere along its height.
  await owner.mouse.move(target.x + target.width / 2, y, { steps: 12 });
  await expect(column('Feito')).toHaveClass(/is-target/);
  await shot(owner, 'quadro-arrastando');
  await owner.mouse.up();
  await expect(cardIn('Feito')).toBeVisible();
  await expect(cardIn('Fazendo')).toHaveCount(0);

  // The server has it: it is still there after a reload.
  await owner.reload();
  await expect(cardIn('Feito')).toBeVisible();
  // The way for the keyboard: the stage menu on the card.
  await owner.getByLabel('Etapa de Conferir perfis').selectOption({ label: 'Fazendo' });
  await expect(cardIn('Fazendo')).toBeVisible();

  // Placed by hand, here the keyboard's way, one place up; everyone sees the same order.
  const inDoing = column('Fazendo').locator('.card .card-title');
  await expect(inDoing).toHaveText(['Subir campanha do cliente', 'Conferir perfis']);
  await cardIn('Fazendo').hover();
  await cardIn('Fazendo').getByRole('button', { name: 'Subir Conferir perfis' }).click();
  await expect(inDoing).toHaveText(['Conferir perfis', 'Subir campanha do cliente']);
  await owner.reload();
  await expect(inDoing).toHaveText(['Conferir perfis', 'Subir campanha do cliente']);

  // A card opens the whole item over the board.
  await column('Fazendo').getByRole('button', { name: 'Conferir perfis', exact: true }).click();
  const dialog = owner.getByRole('dialog', { name: 'Conferir perfis' });
  await expect(dialog.getByLabel('Título')).toHaveValue('Conferir perfis');
  await shot(owner, 'quadro-item-aberto');
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);

  // On a phone the columns stay side by side, and the board scrolls sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  const scrolls = await owner
    .locator('.board')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(scrolls).toBe(true);
  // Only the board scrolls; the page itself stays as wide as the screen.
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(owner, 'quadro-celular');
  await owner.setViewportSize({ width: 1280, height: 900 });
});

test('signing out takes everything the device kept, the key included', async () => {
  const kept = (): Promise<boolean> =>
    owner.evaluate(async () =>
      (await indexedDB.databases()).some((db) => db.name === 'cerebro-offline'),
    );
  expect(await kept()).toBe(true);
  await owner.getByRole('button', { name: 'Sair' }).click();
  await heading(owner, 'Entrar');
  expect(await kept()).toBe(false);
});

test('the page never broke its own security policy along the way', () => {
  expect(problems).toEqual([]);
});
