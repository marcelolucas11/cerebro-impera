import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { describeError } from '../src/messages.js';

describe('what a person reads when a request fails', () => {
  it('says how long to wait after too many attempts', () => {
    expect(describeError(new ApiError(429, 'too_many_attempts', { retryAfterSeconds: 30 }))).toBe(
      'Muitas tentativas. Tente de novo em 30 segundos.',
    );
    expect(describeError(new ApiError(429, 'too_many_attempts', { retryAfterSeconds: 900 }))).toBe(
      'Muitas tentativas. Tente de novo em 15 minutos.',
    );
    expect(describeError(new ApiError(429, 'too_many_attempts'))).toContain('60 segundos');
  });

  it('explains what is wrong with a refused password', () => {
    const message = describeError(new ApiError(400, 'weak_password', { problems: ['too_common'] }));
    expect(message).toContain('listas de senhas vazadas');
    expect(describeError(new ApiError(400, 'weak_password', { problems: ['???'] }))).toBe(
      'Escolha uma senha mais forte.',
    );
  });

  it('gives the same answer for a wrong e-mail and a wrong password', () => {
    expect(describeError(new ApiError(401, 'invalid_credentials'))).toBe(
      'E-mail ou senha incorretos.',
    );
  });

  it('never shows a raw code or technical detail for something unexpected', () => {
    for (const failure of [
      new ApiError(500, 'internal_error'),
      new ApiError(418, 'algo_novo', { stack: 'at db.query (pool.js:1)' }),
      new Error('ECONNRESET'),
      'texto solto',
      undefined,
    ]) {
      const message = describeError(failure);
      expect(message).toBe(
        'O servidor não conseguiu concluir o pedido. Tente de novo em instantes.',
      );
    }
    expect(describeError(new ApiError(0, 'network'))).toContain('conexão');
  });

  it('tells how large a file may be when one is too large', () => {
    const tooLarge = new ApiError(400, 'file_too_large', { maxBytes: 2 * 1024 ** 3 });
    expect(describeError(tooLarge)).toBe(
      'O arquivo passa do limite desta instalação, que é de 2 GB.',
    );
    expect(describeError(new ApiError(400, 'file_too_large'))).toBe(
      'O arquivo passa do limite desta instalação.',
    );
  });
});
