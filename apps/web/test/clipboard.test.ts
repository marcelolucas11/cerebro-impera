import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAR_AFTER_MS, copySensitive } from '../src/clipboard.js';

describe('copying something that opens a door', () => {
  let held = '';
  let inFront = true;
  beforeEach(() => {
    vi.useFakeTimers();
    held = '';
    inFront = true;
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (text: string) => {
          if (!inFront) return Promise.reject(new Error('not focused'));
          held = text;
          return Promise.resolve();
        },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('leaves the clipboard empty 30 seconds later', async () => {
    await copySensitive('https://cerebro.exemplo.test/convite#segredo');
    expect(held).toContain('segredo');
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER_MS - 1);
    expect(held).toContain('segredo');
    await vi.advanceTimersByTimeAsync(1);
    expect(held).toBe('');
  });

  it('counts the 30 seconds from the last copy', async () => {
    await copySensitive('primeiro');
    await vi.advanceTimersByTimeAsync(20_000);
    await copySensitive('segundo');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(held).toBe('segundo');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held).toBe('');
  });

  it('empties it when the person comes back, if the page was not in front', async () => {
    await copySensitive('segredo');
    inFront = false;
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER_MS);
    expect(held).toBe('segredo');
    inFront = true;
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe('');
  });
});
