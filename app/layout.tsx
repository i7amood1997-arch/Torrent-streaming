import type { Metadata, Viewport } from 'next';
import { ErrorBoundary } from '@/components/error-boundary';
import { asset } from '@/lib/config';

import './globals.css';

export const metadata: Metadata = {
  title: 'Streamdeck — Torrent Search & Stream',
  description: 'Search TMDB or raw torrent indexers, stream through Debrid or WebTorrent, with Arabic and English subtitles.',
  applicationName: 'Streamdeck',
  manifest: asset('/manifest.webmanifest'),
  appleWebApp: { capable: true, title: 'Streamdeck', statusBarStyle: 'black' },
  icons: {
    icon: [{ url: asset('/icons/icon.svg?v=2'), type: 'image/svg+xml' }, { url: asset('/icons/icon-192.png?v=2'), sizes: '192x192' }],
    apple: [{ url: asset('/icons/apple-touch-icon.png?v=2'), sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // enables env(safe-area-inset-*) for notch / home indicator
  themeColor: '#000000',
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
      <body>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
