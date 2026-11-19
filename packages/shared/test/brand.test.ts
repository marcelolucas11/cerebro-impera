import { describe, expect, it } from 'vitest';
import {
  BRAND_SURFACE,
  brandColorProblem,
  contrast,
  DEFAULT_BRAND_COLOR,
  inkOn,
  saveBrandSchema,
} from '../src/brand.js';

describe('the brand color', () => {
  it('is the project color by default, and that one reads on the page', () => {
    expect(brandColorProblem(DEFAULT_BRAND_COLOR)).toBeNull();
  });

  it('must be written as #rrggbb', () => {
    for (const value of ['dba63f', '#DBA63F', '#dba63', '#dba63f0', 'red', '#ggg000', ''])
      expect(brandColorProblem(value)).toBe('format');
  });

  it('is refused when it would vanish on the dark surfaces', () => {
    // A strong blue and a purple: fine on white, unreadable on the app's ground.
    expect(brandColorProblem('#2563eb')).toBe('too_dark');
    expect(brandColorProblem('#7c3aed')).toBe('too_dark');
    expect(brandColorProblem('#1c2431')).toBe('too_dark');
    expect(brandColorProblem('#6fb3e0')).toBeNull();
    expect(brandColorProblem('#ffffff')).toBeNull();
  });

  it('carries text on top that always reads, whatever the color', () => {
    for (const color of ['#6fb3e0', '#ffffff', '#a78bfa', '#22c55e', '#ffff00', '#7f9bb0']) {
      expect(brandColorProblem(color)).toBeNull();
      expect(contrast(color, inkOn(color))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inkOn(color), BRAND_SURFACE)).toBeLessThan(contrast(color, BRAND_SURFACE));
    }
    expect(inkOn('#6fb3e0')).toBe('#0d151b');
  });

  it('is saved in lower case, and a dark one is refused by the schema too', () => {
    expect(saveBrandSchema.parse({ name: ' Exemplo ', color: '#6FB3E0', logo: 'keep' })).toEqual({
      name: 'Exemplo',
      color: '#6fb3e0',
      logo: 'keep',
    });
    expect(
      saveBrandSchema.safeParse({ name: 'Exemplo', color: '#2563eb', logo: null }).success,
    ).toBe(false);
  });

  it('takes the logo as exactly three PNGs in base64, or "keep", or none', () => {
    const png = 'iVBORw0KGgo=';
    const logo = { 'icon-192': png, 'icon-512': png, 'maskable-512': png };
    expect(saveBrandSchema.safeParse({ name: 'E', color: null, logo }).success).toBe(true);
    expect(
      saveBrandSchema.safeParse({ name: 'E', color: null, logo: { ...logo, extra: png } }).success,
    ).toBe(false);
    expect(
      saveBrandSchema.safeParse({ name: 'E', color: null, logo: { 'icon-192': png } }).success,
    ).toBe(false);
    expect(
      saveBrandSchema.safeParse({ name: 'E', color: null, logo: { ...logo, 'icon-192': '<svg>' } })
        .success,
    ).toBe(false);
    expect(saveBrandSchema.safeParse({ name: 'E', color: null, logo: 'replace' }).success).toBe(
      false,
    );
  });
});
