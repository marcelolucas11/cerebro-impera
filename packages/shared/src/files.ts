/*
 * Attachments: what both sides agree on. The type here is always the one read
 * from the content by the server, never the name or what the browser claimed.
 */

/** Types shown inside the page. Everything else is always downloaded. */
export const PREVIEWABLE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // PDF is recognised but, for now, always downloaded: see docs/design/anexos.md.
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

export type PreviewKind = 'image' | 'audio' | 'video';

/** How a file can be shown in the page, or null when it can only be downloaded. */
export function previewKind(type: string | null): PreviewKind | null {
  if (type === null || !PREVIEWABLE_TYPES.has(type)) return null;
  const family = type.split('/')[0];
  return family === 'image' || family === 'audio' || family === 'video' ? family : null;
}

export const MAX_FILE_NAME_LENGTH = 255;

/**
 * A name the server accepts: no control characters and no slashes, which
 * could be read as a path. Kept recognisable rather than refused.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    // Control characters are exactly what this removes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)
    .trim();
  return cleaned === '' ? 'arquivo' : cleaned;
}
