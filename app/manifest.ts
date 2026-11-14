import type { MetadataRoute } from 'next';
import { asset } from '@/lib/config';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Streamdeck — Torrent Search & Stream',
    short_name: 'Streamdeck',
    description: 'TMDB discovery, direct torrent search, Debrid/WebTorrent streaming with Arabic & English subtitles.',
    start_url: asset('/'),
    scope: asset('/'),
    display: 'standalone',
    orientation: 'any',
    background_color: '#000000',
    theme_color: '#000000',
    categories: ['entertainment', 'video'],
    icons: [
      { src: asset('/icons/icon-192.png?v=2'), sizes: '192x192', type: 'image/png' },
      { src: asset('/icons/icon-512.png?v=2'), sizes: '512x512', type: 'image/png' },
      { src: asset('/icons/icon-maskable-512.png?v=2'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: asset('/icons/icon.svg?v=2'), sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
