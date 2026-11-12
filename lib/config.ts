/**
 * Build-time deployment settings (inlined by Next at build):
 *  - NEXT_PUBLIC_BASE_PATH: sub-path the static site is served from,
 *    e.g. "/Torrent-streaming" on https://<user>.github.io/Torrent-streaming/
 *  - NEXT_PUBLIC_API_BASE: default URL of the API backend (Cloudflare Worker),
 *    e.g. "https://streamdeck-api.<account>.workers.dev". Users can override it in Settings.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
export const DEFAULT_API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/+$/, '');

/** Prefix a public asset path ("/icons/x.png") with the deployment base path. */
export const asset = (path: string) => `${BASE_PATH}${path}`;
