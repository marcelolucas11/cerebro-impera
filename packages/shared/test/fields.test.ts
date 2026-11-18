import { describe, expect, it } from 'vitest';
import {
  FIELD_KINDS,
  defaultFieldConfig,
  fieldConfigProblem,
  fieldValueProblem,
  MAX_SECRET_LENGTH,
  secretValueProblem,
  type FieldConfig,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const choices: FieldConfig = {
  options: [
    { id: A, name: 'Fornecedor A', color: '#58b98a' },
    { id: B, name: 'Fornecedor B', color: '#dba63f' },
    { id: GONE, name: 'Antigo', color: '#9ba6b8', archived: true },
  ],
};

describe('the configuration of a field', () => {
  it('starts valid for every kind', () => {
    for (const kind of FIELD_KINDS) {
      expect(fieldConfigProblem(kind, defaultFieldConfig(kind)), kind).toBeNull();
    }
  });

  it('accepts only the settings that belong to the kind', () => {
    expect(fieldConfigProblem('text', { currency: 'BRL' })).toBe('unexpected_setting');
    expect(fieldConfigProblem('money', { currency: 'BRL', max: 5 })).toBe('unexpected_setting');
    expect(fieldConfigProblem('select', { options: [], currency: 'BRL' })).toBe(
      'unexpected_setting',
    );
    expect(fieldConfigProblem('text', null)).toBe('unexpected_setting');
    expect(fieldConfigProblem('text', [])).toBe('unexpected_setting');
  });

  it('checks the currency of money and the scale of a rating', () => {
    expect(fieldConfigProblem('money', { currency: 'USD' })).toBeNull();
    for (const currency of ['brl', 'REAL', '', 7, undefined]) {
      expect(fieldConfigProblem('money', { currency })).toBe('invalid_currency');
    }
    expect(fieldConfigProblem('rating', { max: 10 })).toBeNull();
    for (const max of [2, 11, 4.5, '5', undefined]) {
      expect(fieldConfigProblem('rating', { max })).toBe('invalid_max');
    }
  });

  it('checks every option, and refuses repeated ids and repeated names in use', () => {
    expect(fieldConfigProblem('select', choices)).toBeNull();
    expect(fieldConfigProblem('labels', { options: 'A, B' })).toBe('invalid_options');
    const broken: unknown[] = [
      { id: 'a', name: 'X', color: '#58b98a' },
      { id: A, name: '', color: '#58b98a' },
      { id: A, name: ' X ', color: '#58b98a' },
      { id: A, name: 'X', color: 'verde' },
      { id: A, name: 'X', color: '#58B98A' },
      { id: A, name: 'X', color: '#58b98a', archived: 'sim' },
      { id: A, name: 'X', color: '#58b98a', extra: 1 },
      { id: A, name: 'x'.repeat(61), color: '#58b98a' },
      'X',
    ];
    for (const option of broken) {
      expect(fieldConfigProblem('select', { options: [option] }), JSON.stringify(option)).toBe(
        'invalid_options',
      );
    }
    expect(
      fieldConfigProblem('select', {
        options: [
          { id: A, name: 'X', color: '#58b98a' },
          { id: A, name: 'Y', color: '#58b98a' },
        ],
      }),
    ).toBe('duplicate_option');
    expect(
      fieldConfigProblem('select', {
        options: [
          { id: A, name: 'Ativo', color: '#58b98a' },
          { id: B, name: 'ATIVO', color: '#58b98a' },
        ],
      }),
    ).toBe('duplicate_option');
    // An archived option may share its name with the one that replaced it.
    expect(
      fieldConfigProblem('select', {
        options: [
          { id: A, name: 'Ativo', color: '#58b98a', archived: true },
          { id: B, name: 'Ativo', color: '#58b98a' },
        ],
      }),
    ).toBeNull();
    const many = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `Opção ${index}`,
      color: '#58b98a',
    }));
    expect(fieldConfigProblem('labels', { options: many })).toBe('too_many_options');
  });
});

describe('the value of a field', () => {
  it('is text for the text kinds, never blank, within the limit of each', () => {
    expect(fieldValueProblem('text', {}, 'Agência Exemplo')).toBeNull();
    expect(fieldValueProblem('text', {}, 12)).toBe('wrong_type');
    expect(fieldValueProblem('text', {}, '   ')).toBe('empty');
    expect(fieldValueProblem('text', {}, 'x'.repeat(501))).toBe('too_long');
    expect(fieldValueProblem('long_text', {}, 'x'.repeat(501))).toBeNull();
    expect(fieldValueProblem('long_text', {}, 'x'.repeat(20_001))).toBe('too_long');
  });

  it('is a web address, an e-mail or a phone number when the field says so', () => {
    expect(fieldValueProblem('url', {}, 'https://exemplo.test/painel?id=1')).toBeNull();
    for (const value of ['exemplo.test', 'javascript:alert(1)', 'https://a b', 'ftp://x.test']) {
      expect(fieldValueProblem('url', {}, value), value).toBe('invalid_url');
    }
    expect(fieldValueProblem('email', {}, 'contato@exemplo.test')).toBeNull();
    for (const value of ['contato', 'a@b', 'a b@c.test', '@c.test']) {
      expect(fieldValueProblem('email', {}, value), value).toBe('invalid_email');
    }
    expect(fieldValueProblem('phone', {}, '+55 (11) 91234-5678')).toBeNull();
    for (const value of ['ligar depois', '12', '9'.repeat(41)]) {
      expect(fieldValueProblem('phone', {}, value), value).not.toBeNull();
    }
  });

  it('is a number; money is whole cents and a rating stays on its scale', () => {
    expect(fieldValueProblem('number', {}, 12.5)).toBeNull();
    expect(fieldValueProblem('number', {}, '12')).toBe('wrong_type');
    expect(fieldValueProblem('number', {}, Number.NaN)).toBe('wrong_type');
    expect(fieldValueProblem('number', {}, Number.POSITIVE_INFINITY)).toBe('wrong_type');
    expect(fieldValueProblem('number', {}, 1e16)).toBe('out_of_range');
    expect(fieldValueProblem('money', { currency: 'BRL' }, 150_000)).toBeNull();
    expect(fieldValueProblem('money', { currency: 'BRL' }, -990)).toBeNull();
    expect(fieldValueProblem('money', { currency: 'BRL' }, 19.9)).toBe('not_whole');
    expect(fieldValueProblem('rating', { max: 5 }, 5)).toBeNull();
    expect(fieldValueProblem('rating', { max: 5 }, 6)).toBe('out_of_range');
    expect(fieldValueProblem('rating', { max: 5 }, 0)).toBe('out_of_range');
    expect(fieldValueProblem('rating', { max: 5 }, 2.5)).toBe('not_whole');
  });

  it('is yes or no for a checkbox', () => {
    expect(fieldValueProblem('checkbox', {}, true)).toBeNull();
    expect(fieldValueProblem('checkbox', {}, false)).toBeNull();
    expect(fieldValueProblem('checkbox', {}, 'true')).toBe('wrong_type');
    expect(fieldValueProblem('checkbox', {}, 1)).toBe('wrong_type');
  });

  it('is a day that exists, or an exact instant', () => {
    expect(fieldValueProblem('date', {}, '2026-02-28')).toBeNull();
    expect(fieldValueProblem('date', {}, '2028-02-29')).toBeNull();
    for (const value of ['2026-02-30', '2026-13-01', '28/02/2026', '2026-2-8', '0001-01-01', '']) {
      expect(fieldValueProblem('date', {}, value), value).toBe('invalid_date');
    }
    expect(fieldValueProblem('date', {}, 20260228)).toBe('wrong_type');
    expect(fieldValueProblem('datetime', {}, '2026-11-16T09:30:00Z')).toBeNull();
    expect(fieldValueProblem('datetime', {}, '2026-11-16T09:30:00.123Z')).toBeNull();
    for (const value of [
      '2026-11-16',
      '2026-11-16T09:30:00',
      '2026-11-16T09:30:00-03:00',
      '2026-11-16T25:00:00Z',
      '2026-02-30T09:30:00Z',
    ]) {
      expect(fieldValueProblem('datetime', {}, value), value).toBe('invalid_date');
    }
  });

  it('is one of the options of a choice field', () => {
    expect(fieldValueProblem('select', choices, A)).toBeNull();
    expect(fieldValueProblem('select', choices, 'Fornecedor A')).toBe('unknown_option');
    expect(fieldValueProblem('select', choices, [A])).toBe('wrong_type');
    expect(fieldValueProblem('labels', choices, [A, B])).toBeNull();
    expect(fieldValueProblem('labels', choices, A)).toBe('wrong_type');
    expect(fieldValueProblem('labels', choices, [A, 5])).toBe('wrong_type');
    expect(fieldValueProblem('labels', choices, [])).toBe('empty');
    expect(fieldValueProblem('labels', choices, [A, A])).toBe('duplicate_label');
    expect(fieldValueProblem('labels', choices, [A, '44444444-4444-4444-8444-444444444444'])).toBe(
      'unknown_option',
    );
    expect(
      fieldValueProblem(
        'labels',
        choices,
        Array.from({ length: 51 }, () => A),
      ),
    ).toBe('too_many_labels');
  });

  it('may keep an archived option the item already had, and cannot newly choose one', () => {
    expect(fieldValueProblem('select', choices, GONE)).toBe('unknown_option');
    expect(fieldValueProblem('select', choices, GONE, GONE)).toBeNull();
    expect(fieldValueProblem('labels', choices, [A, GONE])).toBe('unknown_option');
    expect(fieldValueProblem('labels', choices, [A, GONE], [GONE])).toBeNull();
    expect(fieldValueProblem('labels', choices, [A, GONE], [B])).toBe('unknown_option');
    // Having had an option that no longer exists at all does not bring it back.
    const other = '55555555-5555-4555-8555-555555555555';
    expect(fieldValueProblem('select', choices, other, other)).toBe('unknown_option');
  });
});

describe('secret values', () => {
  it('never travel among the ordinary values', () => {
    expect(fieldValueProblem('secret', {}, 'senha')).toBe('kept_apart');
  });

  it('are kept exactly as typed, spaces included, up to the limit', () => {
    expect(secretValueProblem('  com espaços  ')).toBeNull();
    expect(secretValueProblem('€'.repeat(MAX_SECRET_LENGTH))).toBeNull();
    expect(secretValueProblem('')).toBe('empty');
    expect(secretValueProblem('x'.repeat(MAX_SECRET_LENGTH + 1))).toBe('too_long');
    expect(secretValueProblem(42)).toBe('wrong_type');
  });
});
