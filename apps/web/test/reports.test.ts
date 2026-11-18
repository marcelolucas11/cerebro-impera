import { describe, expect, it } from 'vitest';
import { change, weekLabel } from '../src/reports.js';

describe('the weekly report in words', () => {
  it('names the week from Monday to Sunday, across months and years', () => {
    expect(weekLabel('2026-11-09')).toBe('09/11 a 15/11/2026');
    expect(weekLabel('2026-11-30')).toBe('30/11 a 06/12/2026');
    expect(weekLabel('2026-12-28')).toBe('28/12 a 03/01/2027');
  });

  it('says how a number moved against the week before, if there was one', () => {
    expect(change(5, null)).toBeNull();
    expect(change(5, 5)).toBe('igual à semana anterior');
    expect(change(7, 4)).toBe('+3 em relação à semana anterior');
    expect(change(2, 4)).toBe('−2 em relação à semana anterior');
  });
});
