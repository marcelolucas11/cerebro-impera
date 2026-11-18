import { describe, expect, it } from 'vitest';
import {
  actionName,
  CAPABILITY_NAMES,
  describeDevice,
  formatBytes,
  formatDuration,
  lastUsed,
} from '../src/labels.js';

describe('how a device is described to whoever approves it', () => {
  it('names the browser and the system', () => {
    const cases: [string, string][] = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Safari no iPhone',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Chrome no Windows',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
        'Edge no Windows',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        'Safari no Mac',
      ],
      [
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
        'Chrome no Android',
      ],
      [
        'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Firefox no Linux',
      ],
    ];
    for (const [userAgent, expected] of cases) expect(describeDevice(userAgent)).toBe(expected);
  });

  it('shows what was sent, cut short, when it cannot tell', () => {
    expect(describeDevice('curl/8.5.0')).toBe('curl/8.5.0');
    expect(describeDevice('x'.repeat(500))).toHaveLength(80);
    expect(describeDevice('')).toBe('Aparelho não identificado');
  });

  it('never says a device was last used "never"', () => {
    expect(lastUsed(null)).toBe('ainda não usado desde a aprovação');
    expect(lastUsed('2030-01-01T12:00:00.000Z')).toMatch(
      /^usado pela última vez em \d{2}\/\d{2}\/\d{4}/,
    );
  });
});

describe('names for what the system records', () => {
  it('puts known actions in plain words and never hides an unknown one', () => {
    expect(actionName('access_grants.insert')).toBe('Acesso concedido');
    expect(actionName('algo.novo')).toBe('algo.novo');
  });

  it('has a name and an explanation for every capability an owner can hand out', () => {
    for (const key of [
      'users.manage',
      'devices.approve',
      'audit.view',
      'export',
      'bulk_delete',
      'automations.manage',
      'secret_fields.reveal',
      'system.config',
    ]) {
      expect(CAPABILITY_NAMES[key]?.name, key).toBeTruthy();
      expect(CAPABILITY_NAMES[key]?.detail, key).toBeTruthy();
    }
  });
});

describe('how long something took, the way people say it', () => {
  it('uses the largest unit that fits and never a fraction', () => {
    const minute = 60_000;
    const cases: [number, string][] = [
      [0, 'menos de 1 minuto'],
      [59_000, 'menos de 1 minuto'],
      [minute, '1 minuto'],
      [59 * minute, '59 minutos'],
      [60 * minute, '1 hora'],
      [23 * 60 * minute + 59 * minute, '23 horas'],
      [24 * 60 * minute, '1 dia'],
      [10 * 24 * 60 * minute + 5 * minute, '10 dias'],
    ];
    for (const [milliseconds, expected] of cases)
      expect(formatDuration(milliseconds)).toBe(expected);
  });

  it('treats a clock that runs backwards as no time at all', () => {
    expect(formatDuration(-5_000)).toBe('menos de 1 minuto');
  });
});

describe('file sizes', () => {
  it('in the largest unit that reads naturally', () => {
    const cases: [number, string][] = [
      [0, '0 bytes'],
      [1000, '1000 bytes'],
      [1024, '1 KB'],
      [839_680, '820 KB'],
      [3.4 * 1024 ** 2, '3,4 MB'],
      [1.25 * 1024 ** 3, '1,3 GB'],
      [5 * 1024 ** 4, '5 TB'],
      [3 * 1024 ** 5, '3.072 TB'],
    ];
    for (const [size, expected] of cases) expect(formatBytes(size)).toBe(expected);
  });
});
