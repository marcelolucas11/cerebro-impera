import { z } from 'zod';

/*
 * The installation's brand: name, color and logo (white label). The color also
 * paints text, so it must stand out from the page's surfaces; the text drawn on
 * top of it is worked out here, so it always reads.
 */

/** The color that ships with the project, for an installation that picked none. */
export const DEFAULT_BRAND_COLOR = '#dba63f';

/** The lightest of the page's dark grounds: the brand color must read on it. */
export const BRAND_SURFACE = '#1c2431';

/** WCAG's minimum for normal text. */
export const MIN_BRAND_CONTRAST = 4.5;

/** The logo's sizes: what a phone, a computer and the app's own menu use. */
export const BRAND_IMAGE_KINDS = ['icon-192', 'icon-512', 'maskable-512'] as const;
export type BrandImageKind = (typeof BRAND_IMAGE_KINDS)[number];

export const BRAND_IMAGE_SIZE: Record<BrandImageKind, number> = {
  'icon-192': 192,
  'icon-512': 512,
  'maskable-512': 512,
};

/** Each PNG, at most. A logo drawn at these sizes is far smaller. */
export const MAX_BRAND_IMAGE_BYTES = 200 * 1024;

const HEX = /^#[0-9a-f]{6}$/;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Relative luminance, as WCAG defines it. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Why a color cannot be the brand's, or null when it can. */
export function brandColorProblem(hex: string): 'format' | 'too_dark' | null {
  if (!HEX.test(hex)) return 'format';
  if (contrast(hex, BRAND_SURFACE) < MIN_BRAND_CONTRAST) return 'too_dark';
  return null;
}

/** The text on top of the brand color: the same hue, nearly black. */
export function inkOn(hex: string): string {
  return `#${channels(hex)
    .map((value) =>
      Math.round(value * 0.12)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export const brandColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => brandColorProblem(value) === null, { message: 'brand_color' });

/** A PNG the browser drew, as base64. Its bytes are checked by the API. */
const pngSchema = z
  .string()
  .max(Math.ceil((MAX_BRAND_IMAGE_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const brandLogoSchema = z.strictObject({
  'icon-192': pngSchema,
  'icon-512': pngSchema,
  'maskable-512': pngSchema,
});

/**
 * Saving the brand. `color: null` goes back to the project's color;
 * `logo: 'keep'` leaves the logo as it is, `null` goes back to the project's.
 */
export const saveBrandSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  color: brandColorSchema.nullable(),
  logo: z.union([z.literal('keep'), z.null(), brandLogoSchema]),
});
export type SaveBrand = z.infer<typeof saveBrandSchema>;

/** What anyone may know about the installation's brand. */
export interface Brand {
  name: string;
  color: string | null;
  /** A short fingerprint of the logo, so a new one is fetched again; null for the project's. */
  logo: string | null;
}
