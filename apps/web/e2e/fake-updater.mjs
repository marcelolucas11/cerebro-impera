/*
 * A stand-in for the updater, for the browser tests only: same address shape,
 * same signed requests (checked with the API's own verification), same
 * answers. It "finds" version 1.5.0 and walks an update through its steps,
 * one step each time it is asked how things are going. Nothing is installed.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const { verify } = await import(
  resolve(import.meta.dirname, '../../../packages/shared/dist/protocol.js')
);

const STEPS = ['backup', 'verify', 'download', 'migrate', 'start', 'health'];

export function startFakeUpdater(key, port) {
  const seen = new Set();
  const state = { current: '1.4.0', checkedAt: null, available: null, job: null };
  const advance = () => {
    const job = state.job;
    if (job === null || job.state !== 'running') return;
    const next = STEPS.indexOf(job.step) + 1;
    if (next < STEPS.length) {
      job.step = STEPS[next];
      return;
    }
    job.state = 'applied';
    job.finishedAt = new Date().toISOString();
    state.current = job.to;
    state.available = null;
  };
  const server = createServer((request, reply) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const answer = (status, value) => {
        reply.writeHead(status, { 'content-type': 'application/json' });
        reply.end(JSON.stringify(value));
      };
      const nonce = request.headers['x-cerebro-nonce'];
      const signed = verify(
        key,
        { method: request.method, path: request.url, body, headers: request.headers },
        Date.now(),
      );
      if (!signed || seen.has(nonce)) return answer(401, { error: { code: 'unsigned' } });
      seen.add(nonce);
      if (request.method === 'GET' && request.url === '/status') {
        advance();
        return answer(200, state);
      }
      if (request.method === 'POST' && request.url === '/check') {
        state.checkedAt = new Date().toISOString();
        if (state.current === '1.4.0') {
          state.available = {
            version: '1.5.0',
            publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
            notes: 'Relatório semanal e aplicativo instalável.\nCorreções na tela inicial.',
          };
        }
        return answer(200, state);
      }
      if (request.method === 'POST' && request.url === '/apply') {
        const { version } = JSON.parse(body);
        if (state.available?.version !== version)
          return answer(409, { error: { code: 'not_available' } });
        if (state.job?.state === 'running') return answer(409, { error: { code: 'busy' } });
        state.job = {
          id: randomUUID(),
          from: state.current,
          to: version,
          state: 'running',
          step: 'backup',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          problem: null,
        };
        return answer(200, state);
      }
      return answer(404, { error: { code: 'not_found' } });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
