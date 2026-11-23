/**
 * Static export for GitHub Pages. The API lives in a separate Cloudflare Worker
 * (worker/index.ts); the frontend calls it via NEXT_PUBLIC_API_BASE / Settings.
 * @type {import('next').NextConfig}
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
/** This build's id (the commit on GitHub): shown in Settings, and lets open apps notice a newer version. */
const buildId = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : `dev-${Date.now().toString(36)}`;

const nextConfig = {
  output: 'export',
  basePath: basePath || undefined,
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  // Debug builds only (DEBUG_SOURCEMAPS=1): readable stack traces in the browser.
  productionBrowserSourceMaps: process.env.DEBUG_SOURCEMAPS === '1',
};

export default nextConfig;
