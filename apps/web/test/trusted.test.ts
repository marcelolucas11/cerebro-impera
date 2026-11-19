import { afterEach, describe, expect, it, vi } from 'vitest';

describe('the one script address the page hands the browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('goes through the policy named in the security policy, which accepts it alone', async () => {
    const made: { name: string; createScriptURL: (input: string) => string }[] = [];
    vi.stubGlobal('trustedTypes', {
      createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => {
        made.push({ name, ...rules });
        return { createScriptURL: (input: string) => ({ trusted: rules.createScriptURL(input) }) };
      },
    });
    const { workerAddress, WORKER_ADDRESS } = await import('../src/trusted.js');
    expect(workerAddress()).toEqual({ trusted: WORKER_ADDRESS });
    workerAddress();
    expect(made.map((policy) => policy.name)).toEqual(['cerebro']);
    const rule = made[0]?.createScriptURL;
    expect(() => rule?.('https://outro.exemplo.test/sw.js')).toThrow();
    expect(() => rule?.('/sw.js?x=1')).toThrow();
  });

  it('is the plain address where the browser has no Trusted Types', async () => {
    const { workerAddress } = await import('../src/trusted.js');
    expect(workerAddress()).toBe('/sw.js');
  });
});
