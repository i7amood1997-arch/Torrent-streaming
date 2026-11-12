import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Streamdeck — Torrent Search & Stream',
    short_name: 'Streamdeck',
    description: 'TMDB discovery, direct torrent search, Debrid/WebTorrent streaming with Arabic & English subtitles.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#07080b',
    theme_color: '#07080b',
    categories: ['entertainment', 'video'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
