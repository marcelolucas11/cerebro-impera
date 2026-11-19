import { describe, expect, it } from 'vitest';
import { iconAddress, placement } from '../src/brand.js';

describe('the logo in the icons', () => {
  it('fills a square icon whole, keeping its shape and centered', () => {
    expect(placement(800, 400, 'icon-512')).toEqual({ x: 0, y: 128, width: 512, height: 256 });
    expect(placement(300, 600, 'icon-192')).toEqual({ x: 48, y: 0, width: 96, height: 192 });
    expect(placement(50, 50, 'icon-512')).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });

  it('stays inside the part a phone never cuts off', () => {
    const box = placement(1000, 1000, 'maskable-512');
    expect(box).toEqual({ x: 113, y: 113, width: 287, height: 287 });
    // Every corner of the logo is within the circle that always shows (80% of the icon).
    const corner = Math.hypot(box.x - 256, box.y - 256);
    expect(corner).toBeLessThanOrEqual(0.4 * 512);
  });

  it('never makes a picture vanish, however thin', () => {
    expect(placement(4000, 1, 'icon-192')).toMatchObject({ width: 192, height: 1 });
  });

  it("points at the installation's logo with its version, or at the project's", () => {
    expect(iconAddress({ logo: null })).toBe('/icons/icon-192.png');
    expect(iconAddress({ logo: 'abc123' }, 'maskable-512')).toBe(
      '/brand/maskable-512.png?v=abc123',
    );
  });
});
