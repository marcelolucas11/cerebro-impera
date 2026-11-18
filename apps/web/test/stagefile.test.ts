import { STAGE_PRESETS } from '@cerebro/shared';
import { describe, expect, it } from 'vitest';
import { readStageFile, stageFileName, stageFileOf } from '../src/stagefile.js';

describe('a set of stages saved as a file', () => {
  it('reads back exactly what was exported', () => {
    for (const preset of STAGE_PRESETS) {
      const file = stageFileOf(preset.name, preset.stages);
      const read = readStageFile(JSON.stringify(file, null, 2));
      expect(read).toEqual({ ok: true, file });
    }
  });

  it('keeps only the name, the color and the meaning of each stage', () => {
    const file = stageFileOf('Lista', [
      { name: 'A', color: '#9ba6b8', kind: 'open', ...{ id: 'x', position: 3 } },
    ]);
    expect(file.stages).toEqual([{ name: 'A', color: '#9ba6b8', kind: 'open' }]);
  });

  it('refuses anything that is not a set of stages, with a sentence', () => {
    const valid = stageFileOf('Lista', [{ name: 'A', color: '#9ba6b8', kind: 'open' }]);
    const wrong: string[] = [
      'não é json',
      '[]',
      'null',
      JSON.stringify({ ...valid, kind: 'outra.coisa' }),
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, stages: [] }),
      JSON.stringify({ ...valid, stages: [{ name: 'A', color: 'azul', kind: 'open' }] }),
      JSON.stringify({ ...valid, stages: [{ name: 'A', color: '#9ba6b8', kind: 'pronto' }] }),
      JSON.stringify({
        ...valid,
        stages: [
          { name: 'A', color: '#9ba6b8', kind: 'open' },
          { name: 'a', color: '#9ba6b8', kind: 'open' },
        ],
      }),
      JSON.stringify({
        ...valid,
        stages: Array.from({ length: 41 }, (_, i) => ({
          name: `E${i}`,
          color: '#9ba6b8',
          kind: 'open',
        })),
      }),
      JSON.stringify({ ...valid, script: '<script>alert(1)</script>' }),
      ' '.repeat(70_000),
    ];
    for (const text of wrong) {
      const read = readStageFile(text);
      expect(read.ok, text.slice(0, 60)).toBe(false);
      if (!read.ok) expect(read.message).toMatch(/^[A-ZÉ][^_]+\.$/);
    }
  });

  it('is named after the list, in plain letters', () => {
    expect(stageFileName('Clientes Ativos')).toBe('etapas-clientes-ativos.json');
    expect(stageFileName('Operação › Perfis M')).toBe('etapas-operacao-perfis-m.json');
    expect(stageFileName('../../etc')).toBe('etapas-etc.json');
    expect(stageFileName('***')).toBe('etapas-lista.json');
  });
});
