/**
 * Static export for GitHub Pages. The API lives in a separate Cloudflare Worker
 * (worker/index.ts); the frontend calls it via NEXT_PUBLIC_API_BASE / Settings.
 * @type {import('next').NextConfig}
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

const nextConfig = {
  output: 'export',
  basePath: basePath || undefined,
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
