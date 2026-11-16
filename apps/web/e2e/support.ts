import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';

export const PASSWORD = 'lagoa-verde-73-tijolo-quente'; // gitleaks:allow (senha fictícia de teste)

interface State {
  databaseUrl: string;
  setupTokenFile: string;
}

function state(): State {
  return JSON.parse(readFileSync(join(tmpdir(), 'cerebro-e2e', 'state.json'), 'utf8')) as State;
}

export function setupToken(): string {
  return readFileSync(state().setupTokenFile, 'utf8').trim();
}

/** Runs one statement as the database superuser: only to arrange a situation, never to assert. */
export async function sql(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: state().databaseUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const WINDOW_MS = 30_000;
const lastWindowUsed = new Map<string, number>();

function decodeBase32(text: string): Buffer {
  let bits = '';
  for (const character of text.replace(/\s/g, '').toUpperCase()) {
    bits += BASE32.indexOf(character).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/**
 * The code an authenticator app would show now. Each code is accepted once,
 * so when this key already spent the current one, wait for the next.
 */
export async function authenticatorCode(secret: string): Promise<string> {
  const key = secret.replace(/\s/g, '');
  let window = Math.floor(Date.now() / WINDOW_MS);
  if (lastWindowUsed.get(key) === window) {
    await new Promise((resolve) =>
      setTimeout(resolve, (window + 1) * WINDOW_MS - Date.now() + 500),
    );
    window = Math.floor(Date.now() / WINDOW_MS);
  }
  lastWindowUsed.set(key, window);

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(window));
  const digest = createHmac('sha1', decodeBase32(key)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

export async function heading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

/** Collects what would show up in the browser console as a real problem (not an expected refusal). */
export function watch(page: Page, problems: string[], who: string): void {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    if (/status of 40[0-9]/.test(message.text())) return;
    problems.push(`[${who}] ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`[${who}] ${error.message}`));
}
