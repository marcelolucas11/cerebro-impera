import { crc32, deflateSync } from 'node:zlib';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPng } from '../src/brand/png.js';
import { Browser, createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import {
  attempt,
  attemptAlone,
  bind,
  buildScenario,
  connectAs,
  type Scenario,
} from './support/scenario.js';

/*
 * The installation's brand: anyone sees it (the sign-in page shows it); only
 * whoever may configure the system changes it, with the code confirmed again;
 * a logo goes in only as clean PNGs of the exact sizes, rebuilt before they are
 * kept, and comes out as an image that can never run.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function part(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

interface PngOptions {
  width?: number;
  height?: number;
  colorType?: number;
  depth?: number;
  interlace?: number;
  /** Parts placed after the header and before the pixels. */
  before?: Buffer[];
  /** Replaces the pixel data, for broken files. */
  pixels?: Buffer;
  after?: Buffer;
}

/** A PNG made the long way, so each test can break exactly one thing. */
function png(size: number, options: PngOptions = {}): Buffer {
  const width = options.width ?? size;
  const height = options.height ?? size;
  const colorType = options.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = options.depth ?? 8;
  header[9] = colorType;
  header[12] = options.interlace ?? 0;
  const row = Buffer.alloc(1 + width * channels, 0x5a);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    SIGNATURE,
    part('IHDR', header),
    ...(options.before ?? []),
    part('IDAT', options.pixels ?? deflateSync(raw)),
    part('IEND'),
    options.after ?? Buffer.alloc(0),
  ]);
}

const logo = (overrides: Partial<Record<string, Buffer>> = {}): Record<string, string> => ({
  'icon-192': (overrides['icon-192'] ?? png(192)).toString('base64'),
  'icon-512': (overrides['icon-512'] ?? png(512)).toString('base64'),
  'maskable-512': (overrides['maskable-512'] ?? png(512)).toString('base64'),
});

interface BrandView {
  name: string;
  color: string | null;
  logo: string | null;
  error?: { code: string; details?: { kind?: string; problem?: string } };
}

let env: TestEnv;
let s: Scenario;
let anyone: Browser;
let app: pg.Client;

const confirmCode = (person: Person): Promise<unknown> =>
  env.admin.query(`UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1`, [person.id]);
const audited = async (action: string): Promise<{ target_id: string; metadata: object }[]> =>
  (
    await env.admin.query<{ target_id: string; metadata: object }>(
      `SELECT target_id, metadata FROM audit.log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  anyone = new Browser(env.app);
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the brand', () => {
  it("is public, and starts as the project's", async () => {
    const seen = await anyone.get<BrandView>('/api/brand');
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({ name: 'Empresa Exemplo', color: null, logo: null });

    const css = await anyone.bytes('GET', '/brand.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body.toString()).not.toContain('--marca');

    const icon = await anyone.bytes('GET', '/brand/icon-192.png');
    expect(icon.status).toBe(302);
    expect(icon.headers.location).toBe('/icons/icon-192.png');
    expect((await anyone.bytes('GET', '/brand/../config/master.key')).status).toBe(404);
    expect((await anyone.bytes('GET', '/brand/icon-192.svg')).status).toBe(404);

    const manifest = await anyone.get<{ icons: { src: string }[] }>('/manifest.webmanifest');
    expect(manifest.body.icons.map((i) => i.src)).toEqual([
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/maskable-512.png',
    ]);
  });

  it('is changed only by whoever may configure the system, with the code confirmed again', async () => {
    const change = { name: 'Outra', color: '#6fb3e0', logo: logo() };
    for (const person of [s.marta, s.nuno, s.ana, s.bruno]) {
      const refused = await person.browser.put<BrandView>('/api/brand', change);
      expect(refused.status, person.id).toBe(403);
    }
    expect((await anyone.put<BrandView>('/api/brand', change)).status).toBe(401);

    await expireStepUp(env, s.owner);
    const unconfirmed = await s.owner.browser.put<BrandView>('/api/brand', change);
    expect(unconfirmed.body.error?.code).toBe('step_up_required');

    // Someone who is not an owner, once given the power, may.
    await confirmCode(s.owner);
    expect(
      (
        await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
          capabilities: ['users.manage', 'devices.approve', 'system.config'],
        })
      ).status,
    ).toBe(200);
    await confirmCode(s.marta);
    const given = await s.marta.browser.put<BrandView>('/api/brand', {
      name: 'Empresa Exemplo',
      color: null,
      logo: 'keep',
    });
    expect(given.status).toBe(200);
    expect((await anyone.get<BrandView>('/api/brand')).body.logo).toBeNull();
  });

  it('takes a color only if it reads on the dark page, and sends it out as a style sheet', async () => {
    await confirmCode(s.owner);
    const dark = await s.owner.browser.put<BrandView>('/api/brand', {
      name: 'Empresa Exemplo',
      color: '#2563eb',
      logo: 'keep',
    });
    expect(dark.status).toBe(400);
    for (const color of ['blue', '#6fb3e0; } body { display: none', 'url(x)']) {
      const odd = await s.owner.browser.put('/api/brand', { name: 'E', color, logo: 'keep' });
      expect(odd.status, color).toBe(400);
    }

    const saved = await s.owner.browser.put<BrandView>('/api/brand', {
      name: '  Empresa Exemplo  ',
      color: '#6FB3E0',
      logo: 'keep',
    });
    expect(saved.body).toEqual({ name: 'Empresa Exemplo', color: '#6fb3e0', logo: null });

    const css = await anyone.bytes('GET', '/brand.css');
    expect(css.body.toString()).toBe(
      'html:root {\n  --marca: #6fb3e0;\n  --sobre-marca: #0d151b;\n}\n',
    );
    const etag = String(css.headers.etag);
    expect(
      (await anyone.bytes('GET', '/brand.css', undefined, { 'if-none-match': etag })).status,
    ).toBe(304);
    expect(
      (await env.admin.query(`SELECT brand_color FROM app.instance_settings`)).rows[0],
    ).toEqual({ brand_color: '#6fb3e0' });
  });

  it('takes a logo as three clean PNGs, rebuilt without anything but the picture', async () => {
    await confirmCode(s.owner);
    const comment = part('tEXt', Buffer.from('Author\0Fulana de Tal, Rua das Flores 12'));
    const saved = await s.owner.browser.put<BrandView>('/api/brand', {
      name: 'Empresa Exemplo',
      color: '#6fb3e0',
      logo: logo({ 'icon-192': png(192, { before: [comment, part('pHYs', Buffer.alloc(9))] }) }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.logo).toMatch(/^[0-9a-f]{16}$/);

    const icon = await anyone.bytes('GET', '/brand/icon-192.png');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['x-content-type-options']).toBe('nosniff');
    expect(icon.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(icon.body.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    expect(icon.body.includes(Buffer.from('Fulana'))).toBe(false);
    expect(icon.body.includes(Buffer.from('pHYs'))).toBe(false);
    expect(icon.body).toEqual(png(192));
    const etag = String(icon.headers.etag);
    expect(
      (await anyone.bytes('GET', '/brand/icon-192.png', undefined, { 'if-none-match': etag }))
        .status,
    ).toBe(304);

    const manifest = await anyone.get<{ icons: { src: string }[] }>('/manifest.webmanifest');
    expect(manifest.body.icons.map((i) => i.src)).toEqual([
      `/brand/icon-192.png?v=${saved.body.logo ?? ''}`,
      `/brand/icon-512.png?v=${saved.body.logo ?? ''}`,
      `/brand/maskable-512.png?v=${saved.body.logo ?? ''}`,
    ]);

    // On the record: which size and its digest, never the picture.
    const record = await audited('brand_images.insert');
    expect(record.map((r) => r.target_id).sort()).toEqual(['icon-192', 'icon-512', 'maskable-512']);
    expect(JSON.stringify(record)).not.toContain('iVBOR');
    for (const entry of record) {
      expect(Object.keys(entry.metadata)).toEqual(['digest']);
      expect((entry.metadata as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const who = await env.admin.query(`SELECT DISTINCT updated_by FROM app.brand_images`);
    expect(who.rows).toEqual([{ updated_by: s.owner.id }]);
  });

  it('refuses any file that is not a clean PNG of the exact size, and changes nothing then', async () => {
    await confirmCode(s.owner);
    const before = await anyone.get<BrandView>('/api/brand');
    const broken = png(192);
    // Inside the pixels: the check sum no longer matches.
    broken.writeUInt8(broken.readUInt8(broken.length - 20) ^ 0xff, broken.length - 20);
    const raw512 = Buffer.alloc((1 + 512 * 4) * 512);
    const cases: [string, Buffer | string, string][] = [
      ['icon-192', png(512), 'wrong_size'],
      ['icon-512', png(512, { width: 511 }), 'wrong_size'],
      [
        'icon-192',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
        'not_png',
      ],
      [
        'icon-192',
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]),
        'not_png',
      ],
      ['icon-192', broken, 'damaged'],
      ['icon-192', png(192, { after: Buffer.from('<script>alert(1)</script>') }), 'damaged'],
      ['icon-192', png(192, { before: [part('Xy1W', Buffer.from('x'))] }), 'damaged'],
      ['icon-192', png(192, { before: [part('ABCD', Buffer.from('x'))] }), 'unexpected_part'],
      ['icon-192', png(192, { interlace: 1 }), 'unsupported_format'],
      ['icon-192', png(192, { colorType: 3 }), 'unsupported_format'],
      ['icon-192', png(192, { depth: 16 }), 'unsupported_format'],
      ['icon-192', png(192, { pixels: deflateSync(raw512) }), 'pixels_do_not_add_up'],
      ['icon-192', png(192, { pixels: deflateSync(Buffer.alloc(100)) }), 'pixels_do_not_add_up'],
      ['icon-192', png(192, { pixels: Buffer.from('not zlib at all') }), 'pixels_do_not_add_up'],
    ];
    for (const [kind, file, problem] of cases) {
      const refused = await s.owner.browser.put<BrandView>('/api/brand', {
        name: 'Trocado',
        color: '#ffffff',
        logo: logo({ [kind]: typeof file === 'string' ? Buffer.from(file) : file }),
      });
      expect(refused.status, problem).toBe(400);
      expect(refused.body.error, problem).toEqual({
        code: 'logo_invalid',
        details: { kind, problem },
      });
    }
    const huge = await s.owner.browser.put<BrandView>('/api/brand', {
      name: 'Trocado',
      color: '#ffffff',
      logo: { ...logo(), 'icon-512': Buffer.alloc(210 * 1024, 1).toString('base64') },
    });
    expect(huge.status).toBe(400);
    expect((await anyone.get<BrandView>('/api/brand')).body).toEqual(before.body);
  });

  it("goes back to the project's logo, on the record", async () => {
    await confirmCode(s.owner);
    const back = await s.owner.browser.put<BrandView>('/api/brand', {
      name: 'Empresa Exemplo',
      color: null,
      logo: null,
    });
    expect(back.body).toEqual({ name: 'Empresa Exemplo', color: null, logo: null });
    expect((await anyone.bytes('GET', '/brand/icon-512.png')).status).toBe(302);
    expect((await audited('brand_images.delete')).map((r) => r.target_id).sort()).toEqual([
      'icon-192',
      'icon-512',
      'maskable-512',
    ]);
    expect(
      (await audited('instance_settings.update')).some((r) =>
        JSON.stringify(r.metadata).includes('#6fb3e0'),
      ),
    ).toBe(true);
  });
});

describe('the brand in the database itself', () => {
  const image = png(192);

  it('lets no one without the power, or without the code confirmed again, change it', async () => {
    await env.admin.query(
      `INSERT INTO app.brand_images (kind, png, updated_by)
       VALUES ('icon-192', $1, $2), ('icon-512', $1, $2), ('maskable-512', $1, $2)`,
      [image, s.owner.id],
    );
    const remaining = async (): Promise<unknown> =>
      (await env.admin.query(`SELECT count(*)::int AS n FROM app.brand_images`)).rows[0];

    // Bruno has no power at all.
    expect(await bind(app, s.bruno)).toBe(true);
    expect((await attempt(app, `DELETE FROM app.brand_images`)).rowCount).toBe(0);
    const insert = await attempt(
      app,
      `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`,
      [image],
    );
    expect(insert.code).toBe('42501');
    expect(
      (await attempt(app, `UPDATE app.instance_settings SET brand_color = '#ffffff'`)).rowCount,
    ).toBe(0);
    await app.query('ROLLBACK');

    // The owner, with the code not confirmed lately.
    await expireStepUp(env, s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    expect((await attempt(app, `DELETE FROM app.brand_images`)).rowCount).toBe(0);
    expect(
      (
        await attempt(app, `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`, [
          image,
        ])
      ).code,
    ).toBe('42501');
    expect(
      (await attempt(app, `UPDATE app.instance_settings SET brand_color = '#ffffff'`)).rowCount,
    ).toBe(0);
    await app.query('ROLLBACK');
    expect(await remaining()).toEqual({ n: 3 });
    await env.admin.query(`DELETE FROM app.brand_images`);
  });

  it('keeps a logo whole, a color well formed, and the author true', async () => {
    await confirmCode(s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    expect((await attempt(app, `UPDATE app.instance_settings SET brand_color = '#FFF'`)).code).toBe(
      '23514',
    );
    expect(
      (
        await attempt(app, `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`, [
          Buffer.from('<svg/>'.repeat(20)),
        ])
      ).code,
    ).toBe('23514');
    // Neither smaller than any PNG can be, nor larger than the API lets in.
    for (const size of [8, 205 * 1024]) {
      const odd = Buffer.alloc(size, 1);
      image.copy(odd, 0, 0, 8);
      expect(
        (
          await attempt(app, `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`, [
            odd,
          ])
        ).code,
        String(size),
      ).toBe('23514');
    }
    expect(
      (
        await attempt(app, `INSERT INTO app.brand_images (kind, png) VALUES ('favicon', $1)`, [
          image,
        ])
      ).code,
    ).toBe('23514');
    // Writing the author by hand is not even allowed.
    expect(
      (
        await attempt(
          app,
          `INSERT INTO app.brand_images (kind, png, updated_by) VALUES ('icon-192', $1, $2)`,
          [image, s.bruno.id],
        )
      ).code,
    ).toBe('42501');
    // One size alone does not stay: the logo is all its sizes or none.
    expect(
      (
        await attempt(app, `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`, [
          image,
        ])
      ).ok,
    ).toBe(true);
    const commit = await attemptAlone(app, 'COMMIT');
    expect(commit.code).toBe('23514');
    expect((await env.admin.query(`SELECT count(*)::int AS n FROM app.brand_images`)).rows).toEqual(
      [{ n: 0 }],
    );
  });

  it('cannot be written by the sign-in service, which only reads it', async () => {
    const auth = await connectAs(env, 'cerebro_auth');
    try {
      expect(
        (
          await attemptAlone(
            auth,
            `INSERT INTO app.brand_images (kind, png) VALUES ('icon-192', $1)`,
            [image],
          )
        ).code,
      ).toBe('42501');
      expect((await attemptAlone(auth, `DELETE FROM app.brand_images`)).code).toBe('42501');
      expect(
        (await attemptAlone(auth, `UPDATE app.instance_settings SET brand_color = '#ffffff'`)).code,
      ).toBe('42501');
      expect((await attemptAlone(auth, `SELECT count(*) FROM app.brand_images`)).ok).toBe(true);
    } finally {
      await auth.end();
    }
  });
});

describe('the PNG check on its own', () => {
  it('keeps an RGB picture with its transparency color, and nothing after the end', () => {
    const rgb = png(192, { colorType: 2, before: [part('tRNS', Buffer.alloc(6))] });
    const checked = checkPng(rgb, 192);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.png).toEqual(rgb);
  });

  it('refuses a transparency part where it does not belong, a second header, or no pixels', () => {
    expect(checkPng(png(192, { before: [part('tRNS', Buffer.alloc(6))] }), 192)).toEqual({
      ok: false,
      problem: 'unexpected_part',
    });
    const header = png(192).subarray(8, 33);
    expect(checkPng(png(192, { before: [header] }), 192)).toEqual({
      ok: false,
      problem: 'unexpected_part',
    });
    const noPixels = Buffer.concat([SIGNATURE, header, part('IEND')]);
    expect(checkPng(noPixels, 192)).toEqual({ ok: false, problem: 'pixels_do_not_add_up' });
    expect(checkPng(SIGNATURE, 192)).toEqual({ ok: false, problem: 'damaged' });
    expect(checkPng(Buffer.concat([SIGNATURE, header]), 192)).toEqual({
      ok: false,
      problem: 'damaged',
    });
  });

  it('refuses pixels split around another part, and a row with an unknown filter', () => {
    const raw = Buffer.alloc((1 + 192 * 4) * 192);
    const packed = deflateSync(raw);
    const split = Buffer.concat([
      SIGNATURE,
      png(192).subarray(8, 33),
      part('IDAT', packed.subarray(0, 10)),
      part('tEXt', Buffer.from('a\0b')),
      part('IDAT', packed.subarray(10)),
      part('IEND'),
    ]);
    expect(checkPng(split, 192)).toEqual({ ok: false, problem: 'unexpected_part' });
    raw[(1 + 192 * 4) * 5] = 9;
    expect(checkPng(png(192, { pixels: deflateSync(raw) }), 192)).toEqual({
      ok: false,
      problem: 'pixels_do_not_add_up',
    });
  });
});
