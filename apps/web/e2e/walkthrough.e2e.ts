import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { authenticatorCode, heading, PASSWORD, setupToken, sql, watch } from './support.js';

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

test('the page never broke its own security policy along the way', () => {
  expect(problems).toEqual([]);
});
