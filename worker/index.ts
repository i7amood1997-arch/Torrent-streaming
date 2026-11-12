/**
 * Cloudflare Worker entry — the API backend for the GitHub Pages frontend.
 * Configure keys with `npx wrangler secret put TMDB_API_KEY` (etc.) or in the
 * Cloudflare dashboard; non-secret options live in wrangler.toml [vars].
 */
import { handleApi, type Env } from '../lib/server/handlers';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleApi(request, env);
  },
};
