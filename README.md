# Streamdeck — Torrent Search & Streaming PWA

A cross-platform Progressive Web App (iPhone, iPad, desktop) that combines **TMDB catalog discovery** with **direct torrent indexer search**, streams through **Debrid (HTTP/HLS)** or **in-browser WebTorrent**, and auto-loads **Arabic + English subtitles** with a native-RTL overlay.

> Only stream content you have the rights to access. Indexer sources are configurable and you are responsible for complying with the laws of your country.

## How it's hosted

```
 GitHub Pages (static PWA)                 Cloudflare Worker (free tier)
 https://<user>.github.io/Torrent-streaming ──fetch──▶ https://streamdeck-api.<account>.workers.dev/api/*
   UI, player, WebTorrent, service worker              indexers · TMDB · Debrid · subtitles (CORS + secrets)
```

GitHub Pages can only serve static files. Indexer, Debrid and subtitle APIs mostly don't send CORS headers, and server-side keys must stay secret, so the API runs as a small **Cloudflare Worker**. The site works without it, but only for magnet links via WebTorrent on desktop; it shows a "Backend not connected" banner.

## Deploy

### 1. Site → GitHub Pages
1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
2. Push to the default branch, or run the **Deploy site to GitHub Pages** workflow manually.
   It lints, tests, builds the static export with the correct sub-path, and publishes `out/`.
3. Site URL: `https://i7amood1997-arch.github.io/Torrent-streaming/`

### 2. API → Cloudflare Worker
**From your computer:**
```bash
npm install
npx wrangler login
npx wrangler deploy        # prints https://streamdeck-api.<account>.workers.dev
# optional server-side keys (otherwise each user enters their own in Settings):
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put ACCESS_TOKEN   # set this if you store Debrid keys on the Worker
```

**Or from GitHub Actions:** add the repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`. The **Deploy API Worker** workflow then deploys on every change to `lib/`, `worker/` or `wrangler.toml`.

### 3. Connect them
Either add the repository **variable** `API_BASE_URL` = your Worker URL (Settings → Secrets and variables → Actions → Variables) and re-run the Pages workflow, or paste the Worker URL into the app's **Settings → API backend**.
`ALLOWED_ORIGINS` in `wrangler.toml` already allows `https://i7amood1997-arch.github.io`.

## Local development

```bash
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_BASE=http://localhost:8787
npm run dev:api              # Worker on :8787 (secrets for local dev go in .dev.vars)
npm run dev                  # UI on :3000
npm test                     # unit tests (parsers, indexers, subtitles, Worker handler)
```

On iPhone/iPad: open the site in Safari → Share → **Add to Home Screen**.

## Architecture

```
worker/index.ts               Cloudflare Worker entry → lib/server/handlers.ts
lib/server/handlers.ts        Fetch-API router: /api/config, /api/search, /api/tmdb,
                              /api/debrid/resolve, /api/subtitles, /api/subtitles/file
                              (CORS allow-list, optional ACCESS_TOKEN)
app/
  page.tsx                    App shell: iPhone tabs · iPad dual-pane · desktop sidebar + ⌘K
  layout.tsx, manifest.ts     PWA metadata, safe-area viewport, Cairo/Tajawal/Inter fonts
lib/
  torrent-indexer.ts          Torrentio · Torznab (Jackett/Prowlarr) · YTS · EZTV · apibay adapters,
                              normalise → merge by info-hash → sort by seeders
  release-parser.ts           title → 4K/1080p/720p, HDR/DV, REMUX, source, codec, audio, channels, group
  magnet.ts                   magnet / hex / base32 info-hash parsing, tracker list (incl. WSS)
  debrid.ts                   Real-Debrid (+ HLS transcode for iOS) · TorBox · Debrid-Link
  tmdb.ts                     TMDB v3 key or v4 bearer token
  subtitles.ts                OpenSubtitles + SubDL search & download
  subtitle-parser.ts          SRT/VTT parsing, Arabic charset fix, cue lookup, VTT export, ranking
  codepages.ts                Windows-1256/1252 tables (Workers lack legacy TextDecoders)
  config.ts                   build-time base path + default API URL
  webtorrent-engine.ts        WebTorrent client + service-worker stream server
  result-filters.ts, store.ts, client-api.ts, platform.ts
components/
  torrent-search.tsx          Direct Torrent Search UI: quality pills with counts, seeders slider,
                              HDR/CAM/text/sort filters, mobile filter drawer, Play / copy magnet
  VideoPlayer.tsx             engine orchestration, hls.js, custom controls, gestures, keybinds
  subtitles.tsx               useSubtitles hook, RTL overlay, sync/style panel
  catalog.tsx, search-bar.tsx, settings-panel.tsx, icons.tsx
public/
  sw.js                       app-shell cache + WebTorrent stream proxy (sub-path aware)
  vendor/webtorrent/          WebTorrent 3.0.21 browser build (MIT), self-hosted
.github/workflows/            pages.yml (site) · worker.yml (API)
```

### Search flow
1. **Catalog mode (TMDB):** text → TMDB multi-search → title → (season/episode) → streams by IMDB id.
2. **Fallback:** no TMDB key, a TMDB error, or zero matches → the same text runs as a **raw torrent search**.
3. **Direct Torrent mode** (`⌘/Ctrl + K`): free-text search across text-capable indexers.
4. **Magnet box:** a magnet URI, 40-hex or 32-base32 info-hash, or an `.m3u8`/`.mp4` URL plays immediately. Pasting a magnet into the main search also plays it.

| Indexer   | By IMDB id | By text | Notes |
|-----------|:---:|:---:|---|
| torrentio | ✅ | — | Stremio add-on protocol; gives per-file `fileIdx` for season packs |
| torznab   | ✅ | ✅ | Jackett / Prowlarr — reaches 1337x, TorrentGalaxy, etc. through your own instance |
| yts       | ✅ | ✅ | movies |
| eztv      | ✅ | — | series |
| apibay    | — | ✅ | off by default; enable via `INDEXERS` |

Enable sources with `INDEXERS` in `wrangler.toml` (comma-separated); set `TORZNAB_URL`/`TORZNAB_API_KEY` as Worker secrets. Your Jackett/Prowlarr must be reachable from the internet for the Worker to use it.

### Streaming engines
- **Debrid (primary, required on iOS):** adds the magnet, selects the right file (`fileIdx` → `SxxEyy` match → largest video), polls while uncached (progress bar), then returns a direct link. For Real-Debrid, an **HLS transcode** is requested and preferred on iOS, so MKV/HEVC releases still play in Safari.
- **WebTorrent (desktop Chromium/Firefox):** WebRTC peers only, streamed to `<video>` via the service worker. Used automatically when no Debrid key is set.
- Playback: native HLS on Safari, `hls.js` elsewhere, progressive HTTP for files; resume position saved per torrent.

### Subtitles
- Searched by IMDB id (or TMDB id / title) with season/episode, ranked by similarity to the playing release name; the best **Arabic** and **English** tracks load automatically.
- Arabic is decoded from Windows-1256 when not UTF-8, and rendered `dir="rtl"` with Cairo/Tajawal.
- Dual-language display, per-language **sync offset** (±10 s slider, ±100 ms buttons, `[`/`]` keys), size, background opacity, colour and vertical position, plus local `.srt`/`.vtt` upload.
- iPhone system fullscreen can't show HTML overlays, so the cues (with the offset applied) are also exposed as native `<track>`s that switch on in fullscreen.

### Controls
| Desktop | Touch |
|---|---|
| `⌘/Ctrl K` torrent search · `Space`/`K` play · `F` fullscreen · `←/→` ±10 s (`Shift` ±30) · `↑/↓` volume · `M` mute · `C` subtitles · `[ ]` subtitle delay · `P` PiP · click = play, double-click = fullscreen | tap = controls · double-tap left/right = ∓10 s · double-tap centre = play/pause · horizontal drag = scrub |

## Security notes
- API keys entered in Settings live only in the browser's `localStorage`. They're sent as headers to your own Worker, which forwards them to the provider and never stores them.
- Keys stored as **Worker secrets** can be used by anyone who can reach the Worker. Set `ACCESS_TOKEN` (and enter it in Settings) before storing a Debrid key there. `ALLOWED_ORIGINS` stops other websites from calling the Worker from a browser, but it doesn't stop scripts.
- A client-supplied Torznab URL is ignored unless `ALLOW_CLIENT_TORZNAB=true`, so the Worker isn't an open proxy.
- The subtitle download token only accepts OpenSubtitles file ids or SubDL `/subtitle/*.zip` paths.
