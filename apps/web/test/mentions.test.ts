import { describe, expect, it } from 'vitest';
import { mentionsIn, splitMentions } from '../src/mentions.js';

describe('mentions in a comment', () => {
  const ana = { id: 'ana', name: 'Ana Souza' };
  const anaPaula = { id: 'ana-paula', name: 'Ana Souza Lima' };

  it('sends only the people whose name is still in the text', () => {
    expect(mentionsIn('@Ana Souza, revisa?', [ana])).toEqual(['ana']);
    expect(mentionsIn('Revisa?', [ana])).toEqual([]);
    expect(mentionsIn('@Ana Souza e @Ana Souza', [ana, ana])).toEqual(['ana']);
  });

  it('sets mentions apart, the longer name first, and leaves the rest as written', () => {
    expect(splitMentions('Oi @Ana Souza Lima e @Ana Souza!', [ana.name, anaPaula.name])).toEqual([
      { text: 'Oi ', mention: false },
      { text: '@Ana Souza Lima', mention: true },
      { text: ' e ', mention: false },
      { text: '@Ana Souza', mention: true },
      { text: '!', mention: false },
    ]);
    expect(splitMentions('Sem ninguém (a+b)', [])).toEqual([
      { text: 'Sem ninguém (a+b)', mention: false },
    ]);
    // Characters with a meaning in patterns are only text in a name.
    expect(splitMentions('@J.(x) ok', ['J.(x)'])[0]).toEqual({ text: '@J.(x)', mention: true });
  });
});
