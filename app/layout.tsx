import type { Metadata, Viewport } from 'next';
import { asset } from '@/lib/config';
import './globals.css';

export const metadata: Metadata = {
  title: 'Streamdeck — Torrent Search & Stream',
  description: 'Search TMDB or raw torrent indexers, stream through Debrid or WebTorrent, with Arabic and English subtitles.',
  applicationName: 'Streamdeck',
  manifest: asset('/manifest.webmanifest'),
  appleWebApp: { capable: true, title: 'Streamdeck', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [{ url: asset('/icons/icon.svg'), type: 'image/svg+xml' }, { url: asset('/icons/icon-192.png'), sizes: '192x192' }],
    apple: [{ url: asset('/icons/apple-touch-icon.png'), sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // enables env(safe-area-inset-*) for notch / home indicator
  themeColor: '#07080b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Tajawal:wght@500;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
