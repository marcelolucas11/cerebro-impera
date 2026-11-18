import { describe, expect, it } from 'vitest';
import { stayNote } from '../src/screens/Summary.js';

describe('how long items stay in a stage, in words', () => {
  it('says the average and how many passed, or that nobody left yet', () => {
    expect(stayNote(null, 0)).toBe('ninguém saiu desta etapa em 90 dias');
    expect(stayNote(7200, 1)).toBe('fica em média 2 horas (1 passagem em 90 dias)');
    expect(stayNote(90, 3)).toBe('fica em média 1 minuto (3 passagens em 90 dias)');
  });
});
