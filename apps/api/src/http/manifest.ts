/*
 * The web app manifest: what a phone or computer needs to install the app.
 * The background is the app's own; the name and the icons are the installation's
 * (white label), with the project's icons when it has no logo of its own.
 */

const BACKGROUND = '#141a24';

export interface InstallManifest {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  lang: string;
  icons: { src: string; sizes: string; type: string; purpose: 'any' | 'maskable' }[];
}

export function installManifest(instanceName: string, logo: string | null = null): InstallManifest {
  const name = instanceName.trim() === '' ? 'Cérebro' : instanceName.trim();
  const icon = (file: string): string =>
    logo === null ? `/icons/${file}` : `/brand/${file}?v=${encodeURIComponent(logo)}`;
  return {
    name,
    short_name: name,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    lang: 'pt-BR',
    icons: [
      { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: icon('maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
