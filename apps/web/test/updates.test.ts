import { describe, expect, it } from 'vitest';
import { refusalText, STEP_NAMES, STEP_ORDER, stepState } from '../src/updates.js';

describe('updates in words', () => {
  it('names every step, and places each against the one going on', () => {
    for (const step of [...STEP_ORDER, 'rollback']) expect(STEP_NAMES[step], step).toBeTruthy();
    expect(STEP_ORDER.map((step) => stepState(step, 'download'))).toEqual([
      'done',
      'done',
      'now',
      'next',
      'next',
      'next',
    ]);
    expect(stepState('backup', 'rollback')).toBe('next');
  });

  it('says why the updater refused, and that nothing was installed when it does not know', () => {
    expect(refusalText('signature_invalid')).toContain('não confere com o repositório do projeto');
    expect(refusalText('algo-novo')).toBe(
      'O atualizador recusou: motivo não reconhecido. Nada foi instalado.',
    );
  });
});
