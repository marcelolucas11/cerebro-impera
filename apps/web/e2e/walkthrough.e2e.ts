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

test('everything is on the record, and the record is intact', async () => {
  await owner.getByRole('link', { name: 'Segurança' }).click();
  await heading(owner, 'Segurança');
  await owner.getByRole('button', { name: 'Verificar se o registro está íntegro' }).click();
  await expect(owner.getByText(/Registro íntegro: \d+ entradas conferidas/)).toBeVisible();
  const record = owner.locator('main');
  for (const entry of [
    'Instalação concluída',
    'Pessoa convidada',
    'Link de acesso usado',
    'Aparelho novo pediu aprovação',
    'Aparelho aprovado',
    'Acesso concedido',
    'Lista sensível aberta',
    'Valor secreto revelado',
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

  await ana.reload();
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

test('a list is narrowed and ordered, and stays that way across a reload and the board', async () => {
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
  const handle = await cardIn('Fazendo').locator('.card-handle').boundingBox();
  const target = await column('Feito').boundingBox();
  if (!handle || !target) throw new Error('the board is not laid out');
  await owner.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(target.x + target.width / 2, target.y + 60, { steps: 12 });
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

test('the page never broke its own security policy along the way', () => {
  expect(problems).toEqual([]);
});
