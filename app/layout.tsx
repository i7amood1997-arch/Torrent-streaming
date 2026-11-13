import type { Metadata, Viewport } from 'next';
import { asset } from '@/lib/config';

const APP_HEIGHT_SCRIPT = `(function(){try{
var d=document.documentElement,n=navigator;
var ios=/iPad|iPhone|iPod/.test(n.userAgent)||(n.platform==='MacIntel'&&n.maxTouchPoints>1);
var sa=n.standalone===true||(window.matchMedia&&matchMedia('(display-mode: standalone)').matches);
function set(){var h=window.innerHeight;
if(ios&&sa){var portrait=h>=window.innerWidth;var s=portrait?Math.max(screen.height,screen.width):Math.min(screen.height,screen.width);if(s>h)h=s;}
d.style.setProperty('--app-h',h+'px');d.classList.toggle('standalone',!!sa);}
set();addEventListener('resize',set);addEventListener('orientationchange',function(){setTimeout(set,250);});
}catch(e){}})();`;
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
        {/*
          iOS home-screen (standalone) mode can report a viewport that is shorter than the screen
          by the status-bar height, shifting the page up and leaving a gap at the bottom. Measure the
          real height and expose it as --app-h before first paint (and on rotation/resize).
        */}
        <script dangerouslySetInnerHTML={{ __html: APP_HEIGHT_SCRIPT }} />
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
