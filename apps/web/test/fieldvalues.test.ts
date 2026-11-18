import type { FieldConfig, FieldKind } from '@cerebro/shared';
import { describe, expect, it } from 'vitest';
import {
  draftOf,
  linkOf,
  optionsOf,
  parseDecimal,
  sameValue,
  showValue,
  valueOf,
  type FieldLike,
} from '../src/fieldvalues.js';
import { describeError } from '../src/messages.js';
import { ApiError } from '../src/api.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';

const field = (kind: FieldKind, config: FieldConfig = {}): FieldLike => ({
  id: 'campo',
  name: 'Campo',
  kind,
  config,
});
const supplier = field('select', {
  options: [
    { id: A, name: 'Alfa', color: '#58b98a' },
    { id: B, name: 'Beta', color: '#dba63f' },
    { id: OLD, name: 'Antigo', color: '#9ba6b8', archived: true },
  ],
});
const tags = { ...supplier, kind: 'labels' as const };

/** Narrow no-break spaces and the like differ between runtimes; compare with plain spaces. */
const plain = (text: string): string => text.replace(/\s/g, ' ');

describe('a number as people type it here', () => {
  it('takes a comma for decimals and dots for thousands', () => {
    const cases: [string, number | null][] = [
      ['12', 12],
      ['12,5', 12.5],
      ['12.5', 12.5],
      ['1.500', 1500],
      ['1.499,90', 1499.9],
      ['1499.90', 1499.9],
      ['1.234.567', 1234567],
      [' 1 250,50 ', 1250.5],
      ['-3,2', -3.2],
      ['0,5', 0.5],
      ['', null],
      ['doze', null],
      ['1,2,3', null],
      ['1.2.3', null],
      ['12abc', null],
      [',', null],
      ['1e5', null],
    ];
    for (const [typed, expected] of cases) expect(parseDecimal(typed), typed).toBe(expected);
  });
});

describe('what is typed in a field', () => {
  it('becomes the value to store, or nothing when left blank', () => {
    expect(valueOf(field('text'), '  Agência Exemplo ', undefined)).toEqual({
      ok: true,
      value: 'Agência Exemplo',
    });
    expect(valueOf(field('text'), '   ', undefined)).toEqual({ ok: true, value: null });
    expect(valueOf(field('number'), '12,5', undefined)).toEqual({ ok: true, value: 12.5 });
    expect(valueOf(field('number'), '', 3)).toEqual({ ok: true, value: null });
    expect(valueOf(field('rating', { max: 5 }), '4', undefined)).toEqual({ ok: true, value: 4 });
    expect(valueOf(field('date'), '2026-11-16', undefined)).toEqual({
      ok: true,
      value: '2026-11-16',
    });
    expect(valueOf(supplier, A, undefined)).toEqual({ ok: true, value: A });
    expect(valueOf(supplier, '', A)).toEqual({ ok: true, value: null });
    expect(valueOf(tags, [A, B], undefined)).toEqual({ ok: true, value: [A, B] });
    expect(valueOf(tags, [], [A])).toEqual({ ok: true, value: null });
    expect(valueOf(field('checkbox'), true, undefined)).toEqual({ ok: true, value: true });
    expect(valueOf(field('checkbox'), false, true)).toEqual({ ok: true, value: null });
  });

  it('stores money as whole cents, without rounding surprises', () => {
    const money = field('money', { currency: 'BRL' });
    for (const [typed, cents] of [
      ['1.499,90', 149_990],
      ['149,9', 14_990],
      ['0,07', 7],
      ['19,99', 1999],
      ['1.500', 150_000],
      ['-20', -2000],
    ] as const) {
      expect(valueOf(money, typed, undefined), typed).toEqual({ ok: true, value: cents });
    }
    const fractions = valueOf(money, '10,999', undefined);
    expect(fractions.ok).toBe(false);
  });

  it('stores a local date and time as an exact instant and shows it back the same', () => {
    const when = field('datetime');
    const parsed = valueOf(when, '2026-11-16T09:30', undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || typeof parsed.value !== 'string') throw new Error('expected an instant');
    expect(parsed.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(parsed.value).getTime()).toBe(new Date(2026, 10, 16, 9, 30).getTime());
    expect(draftOf(when, parsed.value)).toBe('2026-11-16T09:30');
  });

  it('says what to fix, in words, when it does not fit', () => {
    const wrong: [FieldLike, string][] = [
      [field('number'), 'muitos'],
      [field('url'), 'exemplo.test'],
      [field('url'), 'javascript:alert(1)'],
      [field('email'), 'contato'],
      [field('phone'), 'ligar amanhã'],
      [field('date'), '2026-02-30'],
      [field('rating', { max: 3 }), '4'],
      [supplier, OLD],
    ];
    for (const [target, typed] of wrong) {
      const result = valueOf(target, typed, undefined);
      expect(result.ok, `${target.kind}: ${typed}`).toBe(false);
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(10);
        expect(result.message).not.toMatch(/[a-z]+_[a-z]+/);
      }
    }
  });

  it('lets an item keep an archived option it already has', () => {
    expect(valueOf(supplier, OLD, OLD)).toEqual({ ok: true, value: OLD });
    expect(valueOf(tags, [A, OLD], [OLD])).toEqual({ ok: true, value: [A, OLD] });
    expect(valueOf(tags, [A, OLD], [A]).ok).toBe(false);
  });

  it('starts from what is stored', () => {
    expect(draftOf(field('text'), 'Olá')).toBe('Olá');
    expect(draftOf(field('text'), undefined)).toBe('');
    expect(draftOf(field('number'), 1250.5)).toBe('1250,5');
    expect(draftOf(field('money', { currency: 'BRL' }), 149_990)).toBe('1499,90');
    expect(draftOf(field('money', { currency: 'BRL' }), 7)).toBe('0,07');
    expect(draftOf(field('rating', { max: 5 }), 4)).toBe('4');
    expect(draftOf(field('checkbox'), true)).toBe(true);
    expect(draftOf(field('checkbox'), undefined)).toBe(false);
    expect(draftOf(tags, [A])).toEqual([A]);
    expect(draftOf(tags, undefined)).toEqual([]);
    // Typing back exactly what was shown changes nothing.
    for (const [target, stored] of [
      [field('number'), 1250.5],
      [field('money', { currency: 'BRL' }), 149_990],
      [field('rating', { max: 5 }), 4],
      [field('date'), '2026-11-16'],
      [supplier, B],
    ] as const) {
      const again = valueOf(target, draftOf(target, stored), stored);
      expect(again).toEqual({ ok: true, value: stored });
    }
  });

  it('compares marker lists whatever their order', () => {
    expect(sameValue([A, B], [B, A])).toBe(true);
    expect(sameValue([A], [A, B])).toBe(false);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue(1, 2)).toBe(false);
    expect(sameValue(true, null)).toBe(false);
  });
});

describe('a people field', () => {
  const people = field('people');
  it('takes the people chosen, or nothing', () => {
    expect(valueOf(people, [A, B], undefined)).toEqual({ ok: true, value: [A, B] });
    expect(valueOf(people, [], [A])).toEqual({ ok: true, value: null });
    expect(valueOf(people, [A, A], undefined).ok).toBe(false);
    expect(draftOf(people, [A])).toEqual([A]);
    expect(draftOf(people, undefined)).toEqual([]);
  });

  it('is read as names when names are known, and as a count otherwise', () => {
    const names: Record<string, string> = { [A]: 'Ana', [B]: 'Bruno' };
    expect(showValue(people, [A, B], (id) => names[id] ?? 'outra pessoa')).toBe('Ana, Bruno');
    expect(showValue(people, [A])).toBe('1 pessoa');
    expect(showValue(people, [A, B])).toBe('2 pessoas');
    expect(showValue(people, undefined)).toBe('');
  });
});

describe('a files field', () => {
  const contract = field('files');
  it('takes the files chosen, or nothing, and is read as a count', () => {
    expect(valueOf(contract, [A, B], undefined)).toEqual({ ok: true, value: [A, B] });
    expect(valueOf(contract, [], [A])).toEqual({ ok: true, value: null });
    expect(draftOf(contract, [A])).toEqual([A]);
    expect(showValue(contract, [A])).toBe('1 arquivo');
    expect(showValue(contract, [A, B])).toBe('2 arquivos');
  });

  it('explains a file that is no longer attached', () => {
    const refused = new ApiError(400, 'invalid_field_value', { problem: 'unknown_file' });
    expect(describeError(refused)).toContain('não está mais entre os anexos');
  });
});

describe('a stored value as it is read', () => {
  it('is written the way people here write numbers, money and dates', () => {
    expect(showValue(field('number'), 1250.5)).toBe('1.250,5');
    expect(plain(showValue(field('money', { currency: 'BRL' }), 149_990))).toBe('R$ 1.499,90');
    expect(plain(showValue(field('money', { currency: 'USD' }), 500))).toContain('5,00');
    expect(showValue(field('date'), '2026-11-03')).toBe('03/11/2026');
    expect(showValue(field('date'), '2026-01-01')).toBe('01/01/2026');
    expect(showValue(field('rating', { max: 5 }), 4)).toBe('4 de 5');
    expect(showValue(field('checkbox'), true)).toBe('Sim');
    expect(showValue(field('checkbox'), undefined)).toBe('Não');
    expect(showValue(field('text'), undefined)).toBe('');
    expect(showValue(field('datetime'), '2026-11-16T12:30:00.000Z')).toMatch(/\d{2}\/11\/2026/);
  });

  it('names the chosen options, skipping any that no longer exist', () => {
    expect(showValue(supplier, B)).toBe('Beta');
    expect(showValue(tags, [B, OLD])).toBe('Beta, Antigo');
    expect(showValue(tags, [B, '44444444-4444-4444-8444-444444444444'])).toBe('Beta');
    expect(optionsOf(tags, [OLD])).toEqual([
      { id: OLD, name: 'Antigo', color: '#9ba6b8', archived: true },
    ]);
    expect(optionsOf(supplier, undefined)).toEqual([]);
  });

  it('only becomes a link when the address is safe to follow', () => {
    expect(linkOf(field('url'), 'https://exemplo.test/painel')).toBe('https://exemplo.test/painel');
    expect(linkOf(field('email'), 'contato@exemplo.test')).toBe('mailto:contato@exemplo.test');
    expect(linkOf(field('phone'), '+55 (11) 91234-5678')).toBe('tel:+5511912345678');
    // Whatever ended up stored, these never turn into something a click would run.
    for (const stored of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'https://exemplo.test/a b',
    ]) {
      expect(linkOf(field('url'), stored), stored).toBeNull();
    }
    expect(linkOf(field('email'), 'a@b.c?subject=x y')).toBeNull();
    expect(linkOf(field('phone'), 'javascript:1')).toBeNull();
    expect(linkOf(field('text'), 'https://exemplo.test')).toBeNull();
  });
});

describe('a refused field value', () => {
  it('is explained in words', () => {
    const refusal = new ApiError(400, 'invalid_field_value', {
      fieldId: 'x',
      problem: 'invalid_date',
    });
    expect(describeError(refusal)).toContain('data');
    const unknown = new ApiError(400, 'invalid_field_value', { problem: 'something_new' });
    expect(describeError(unknown)).not.toContain('something_new');
    for (const code of ['too_many_fields', 'option_cannot_be_removed', 'rating_scale_is_fixed']) {
      expect(describeError(new ApiError(409, code))).not.toMatch(/servidor não conseguiu/);
    }
  });
});
