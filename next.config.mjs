/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'image.tmdb.org' }],
  },
  async headers() {
    return [
      {
        // The service worker must never be cached by the HTTP cache, and needs
        // root scope so WebTorrent's stream URLs (/webtorrent/...) are intercepted.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
