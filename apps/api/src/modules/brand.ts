import {
  BRAND_IMAGE_KINDS,
  BRAND_IMAGE_SIZE,
  inkOn,
  MAX_BRAND_IMAGE_BYTES,
  type Brand,
  type BrandImageKind,
  type SaveBrand,
} from '@cerebro/shared';
import { requireCapability, requireStepUp, type Actor } from '../actor.js';
import { checkPng } from '../brand/png.js';
import { one, run, sql, type Queryable, type Tx } from '../db.js';
import { badRequest } from '../http/errors.js';

/*
 * The installation's brand (white label): name, color and logo. Anyone may see
 * it, since the sign-in page shows it before a password; only whoever may
 * configure the system changes it, with the code confirmed again, and the
 * database holds both lines on its own.
 */

interface BrandRow {
  instance_name: string;
  brand_color: string | null;
  logo: string | null;
}

/** The brand as anyone may see it. Read through the sign-in service: no session needed. */
export async function brand(db: Queryable): Promise<Brand> {
  const row = await one<BrandRow>(
    db,
    sql`SELECT i.instance_name, i.brand_color,
               (SELECT left(string_agg(b.digest, '' ORDER BY b.kind), 16)
                  FROM app.brand_images b) AS logo
          FROM app.instance_settings i`,
  );
  return {
    name: row?.instance_name ?? '',
    color: row?.brand_color ?? null,
    logo: row?.logo ?? null,
  };
}

/** One of the logo's sizes, or null when the installation uses the project's. */
export async function brandImage(
  db: Queryable,
  kind: BrandImageKind,
): Promise<{ png: Buffer; digest: string } | null> {
  const row = await one<{ png: Buffer; digest: string }>(
    db,
    sql`SELECT png, digest FROM app.brand_images WHERE kind = ${kind}`,
  );
  return row ?? null;
}

/**
 * The color as a style sheet the page links to, so the brand is there from the
 * first paint. The values come only from the database, where they are checked
 * as #rrggbb, and are checked again here before being written out.
 */
export function brandStyleSheet(color: string | null): string {
  if (color === null || !/^#[0-9a-f]{6}$/.test(color)) return '/* A cor de fábrica. */\n';
  return `html:root {\n  --marca: ${color};\n  --sobre-marca: ${inkOn(color)};\n}\n`;
}

function decodeLogo(logo: Exclude<SaveBrand['logo'], 'keep' | null>): Map<BrandImageKind, Buffer> {
  const images = new Map<BrandImageKind, Buffer>();
  for (const kind of BRAND_IMAGE_KINDS) {
    const bytes = Buffer.from(logo[kind], 'base64');
    if (bytes.length > MAX_BRAND_IMAGE_BYTES) throw badRequest('logo_too_large', { kind });
    const checked = checkPng(bytes, BRAND_IMAGE_SIZE[kind]);
    if (!checked.ok) throw badRequest('logo_invalid', { kind, problem: checked.problem });
    images.set(kind, checked.png);
  }
  return images;
}

/** Saves name, color and logo together. */
export async function saveBrand(tx: Tx, actor: Actor, body: SaveBrand): Promise<Brand> {
  requireCapability(actor, 'system.config');
  requireStepUp(actor);
  // Every file is checked before anything changes.
  const images = body.logo === 'keep' || body.logo === null ? null : decodeLogo(body.logo);

  await run(
    tx,
    sql`UPDATE app.instance_settings
          SET instance_name = ${body.name}, brand_color = ${body.color}`,
  );
  if (body.logo !== 'keep') {
    await run(tx, sql`DELETE FROM app.brand_images`);
    for (const [kind, png] of images ?? []) {
      await run(tx, sql`INSERT INTO app.brand_images (kind, png) VALUES (${kind}, ${png})`);
    }
  }
  return brand(tx);
}
