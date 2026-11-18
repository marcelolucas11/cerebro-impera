/*
 * The web app manifest: what a phone or computer needs to install the app.
 * Colors are the app's own; the name is the installation's (white label).
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

export function installManifest(instanceName: string): InstallManifest {
  const name = instanceName.trim() === '' ? 'Cérebro' : instanceName.trim();
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
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
