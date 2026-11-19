import {
  BRAND_IMAGE_KINDS,
  BRAND_IMAGE_SIZE,
  MAX_BRAND_IMAGE_BYTES,
  type Brand,
  type BrandImageKind,
} from '@cerebro/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api.js';

/*
 * The installation's brand on the page: its name in the tab, its logo as the
 * tab's icon, its color through /brand.css. And the logo itself, drawn here
 * from the file the person picks: the server never receives that file, only
 * the three PNG pictures the browser draws from it.
 */

/** What the person may pick. Never SVG: a drawing that can carry a script. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** The page's dark ground, behind the logo in the icon a phone cuts to its own shape. */
const GROUND = '#141a24';

/**
 * Within an icon a phone cuts to a circle, only the middle 80% is sure to
 * show; the largest square inside that circle is about 56% of the icon.
 */
const MASKABLE_SAFE = 0.56;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the picture goes in an icon: whole, centered, as large as it fits. */
export function placement(sourceWidth: number, sourceHeight: number, kind: BrandImageKind): Box {
  const size = BRAND_IMAGE_SIZE[kind];
  const room = kind === 'maskable-512' ? Math.round(size * MASKABLE_SAFE) : size;
  const scale = Math.min(room / sourceWidth, room / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return { x: Math.round((size - width) / 2), y: Math.round((size - height) / 2), width, height };
}

export type LogoProblem = 'type' | 'unreadable' | 'too_large';

export interface DrawnLogo {
  /** To show what each icon will look like, with no address involved. */
  canvases: Record<BrandImageKind, HTMLCanvasElement>;
  /** To send: each picture as a PNG, in base64. */
  files: Record<BrandImageKind, string>;
}

function toBase64(bytes: ArrayBuffer): string {
  let text = '';
  const view = new Uint8Array(bytes);
  for (let at = 0; at < view.length; at += 0x8000) {
    text += String.fromCharCode(...view.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

function pngOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

/** Draws the picked file into the three icons, or says why it cannot. */
export async function drawLogo(file: Blob): Promise<DrawnLogo | LogoProblem> {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  let picture: ImageBitmap;
  try {
    picture = await createImageBitmap(file);
  } catch {
    return 'unreadable';
  }
  const canvases = {} as Record<BrandImageKind, HTMLCanvasElement>;
  const files = {} as Record<BrandImageKind, string>;
  try {
    for (const kind of BRAND_IMAGE_KINDS) {
      const size = BRAND_IMAGE_SIZE[kind];
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (context === null) return 'unreadable';
      if (kind === 'maskable-512') {
        context.fillStyle = GROUND;
        context.fillRect(0, 0, size, size);
      }
      const box = placement(picture.width, picture.height, kind);
      context.imageSmoothingQuality = 'high';
      context.drawImage(picture, box.x, box.y, box.width, box.height);
      const png = await pngOf(canvas);
      if (png === null) return 'unreadable';
      if (png.size > MAX_BRAND_IMAGE_BYTES) return 'too_large';
      canvases[kind] = canvas;
      files[kind] = toBase64(await png.arrayBuffer());
    }
  } finally {
    picture.close();
  }
  return { canvases, files };
}

export const LOGO_PROBLEMS: Record<LogoProblem, string> = {
  type: 'Use um arquivo PNG, JPEG ou WebP. SVG não é aceito, porque pode carregar código.',
  unreadable: 'Este arquivo não abriu como imagem. Tente exportar o logo de novo, em PNG.',
  too_large:
    'O logo ficou pesado demais depois de ajustado. Use uma versão mais simples, em cores chapadas e sem fundo de foto.',
};

/** Where an icon of the installation is: its own logo, or the project's. */
export function iconAddress(brand: Pick<Brand, 'logo'>, kind: BrandImageKind = 'icon-192'): string {
  return brand.logo === null
    ? `/icons/${kind}.png`
    : `/brand/${kind}.png?v=${encodeURIComponent(brand.logo)}`;
}

let projectIcon: string | null = null;
/** The color the page shows; undefined while it is the one it was opened with. */
let shownColor: string | null | undefined;

/** Puts the brand on the page itself: tab title and icon, and the color sheet. */
export function showBrand(brand: Brand): void {
  document.title = brand.name.trim() === '' ? 'Cérebro' : brand.name;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon !== null) {
    projectIcon ??= icon.href;
    icon.type = brand.logo === null ? 'image/svg+xml' : 'image/png';
    icon.href = brand.logo === null ? projectIcon : iconAddress(brand);
  }
  const touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (touch !== null) {
    touch.href = brand.logo === null ? '/icons/apple-touch-180.png' : iconAddress(brand);
  }
  // The page came with the color of that moment. When it changes, a new address makes
  // the browser fetch the sheet again, right away.
  const sheet = document.querySelector<HTMLLinkElement>('link#brand-style');
  if (sheet !== null && shownColor !== undefined && shownColor !== brand.color) {
    sheet.href = `/brand.css?v=${encodeURIComponent(brand.color ?? 'fabrica')}`;
  }
  shownColor = brand.color;
}

/** The brand for any screen, signed in or not; kept on the page as it changes. */
export function useBrand(): Brand | undefined {
  const brand = useQuery({ queryKey: ['brand'], queryFn: api.brand });
  useEffect(() => {
    if (brand.data) showBrand(brand.data);
  }, [brand.data]);
  return brand.data;
}
