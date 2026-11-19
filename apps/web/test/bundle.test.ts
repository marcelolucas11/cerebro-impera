import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The page is served under a policy that allows nothing inline and nothing
 * from other origins. If the build ever starts producing such a thing, the
 * app would simply stop working in the browser; this catches it first.
 */

const dist = join(import.meta.dirname, '..', 'dist');
const page = readFileSync(join(dist, 'index.html'), 'utf8');

describe('the built page', () => {
  it('loads scripts and styles only from its own /assets/ folder', () => {
    // Case-insensitive, and accepting anything before the closing ">" ("</script foo>"):
    // the browser does, so the check must too.
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    // Every opening tag is one of those checked here, however it is written.
    expect(page.match(/<script\b/gi)).toHaveLength(scripts.length);
    for (const [, attributes = '', body = ''] of scripts) {
      expect(attributes).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
      expect(body.trim()).toBe('');
    }
    // Besides /assets/, only the install icons (also in the bundle), and two files the API
    // writes for the installation: the manifest (its name) and /brand.css (its color, D70),
    // whose copy in the bundle is the project's color.
    for (const [, reference = ''] of page.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      if (reference === '/manifest.webmanifest') continue;
      if (reference === '/brand.css') {
        expect(existsSync(join(dist, reference))).toBe(true);
        continue;
      }
      expect(/^\/(?:assets|icons)\//.test(reference), reference).toBe(true);
      expect(existsSync(join(dist, reference)), reference).toBe(true);
    }
  });

  it('has no inline style, inline handler or address outside this origin', () => {
    expect(page).not.toMatch(/<style\b/i);
    expect(page).not.toMatch(/\sstyle\s*=/i);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/https?:\/\//i);
    expect(page).not.toMatch(/javascript:/i);
  });

  it('asks browsers and search engines to keep it out of sight', () => {
    expect(page).toContain('<meta name="robots" content="noindex, nofollow"');
    expect(page).toContain('<meta name="referrer" content="no-referrer"');
  });

  it('ships its own fonts, and its styles reach for nothing outside', () => {
    const assets = readdirSync(join(dist, 'assets'));
    expect(assets.some((name) => name.endsWith('.woff2'))).toBe(true);
    for (const name of assets.filter((asset) => asset.endsWith('.css'))) {
      const css = readFileSync(join(dist, 'assets', name), 'utf8');
      expect(css, name).not.toMatch(/url\(\s*["']?(?:https?:|\/\/|data:)/i);
      expect(css, name).not.toMatch(/@import/i);
    }
  });

  it('has a service worker that keeps only the page and its files, and never the API', () => {
    const worker = readFileSync(join(dist, 'sw.js'), 'utf8');
    const kept = [...worker.matchAll(/`(\/assets\/[^`]+)`/g)].map((match) => match[1] ?? '');
    expect(kept.sort()).toEqual(
      readdirSync(join(dist, 'assets'))
        .map((name) => `/assets/${name}`)
        .sort(),
    );
    expect(worker).toContain('`/index.html`');
    expect(worker).not.toMatch(/https?:\/\//i);
    expect(worker).not.toMatch(/\bimportScripts\b|\beval\(|new Function/);
  });
});
