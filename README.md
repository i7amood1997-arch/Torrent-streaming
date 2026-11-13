# Streamdeck — Torrent Search & Streaming PWA

A cross-platform Progressive Web App (iPhone, iPad, desktop) that combines **TMDB catalog discovery** with **direct torrent indexer search**, streams through **Debrid (HTTP/HLS)** or **in-browser WebTorrent**, and auto-loads **Arabic + English subtitles** with a native-RTL overlay.

> Only stream content you have the rights to access. Indexer sources are configurable and you are responsible for complying with the laws of your country.

## Use it

**https://i7amood1997-arch.github.io/Torrent-streaming/** is hosted free on GitHub Pages. There's no server to set up.

1. Open the link. On iPhone/iPad, tap Share → **Add to Home Screen** to use it like an app.
2. Nothing is required. The catalog (Cinemeta) and Arabic/English subtitles (OpenSubtitles feed) work without keys. Optional keys in **Settings**:
   - **TMDB** (alternative catalog with more metadata): themoviedb.org → Settings → API
   - **Real-Debrid / TorBox / Debrid-Link** (optional, paid): fastest, and handles every file format. Without a key, your own relay streams torrents into the app for free (MKV is converted on the fly on iPhone), with webtor.io as a fallback.
   - **OpenSubtitles / SubDL** (adds release-matched subtitle results)
3. Choose your **Torrent sources** in Settings and start searching.

Keys are saved only in your browser.

### How it works without a server
The API code (`lib/server/handlers.ts`) runs **inside the browser** ("direct mode") and calls each service directly.

If a site is blocked, either because it refuses requests from websites (CORS) or because your internet provider blocks it, there are two fixes:

1. **Public relays (automatic, on by default):** searches for blocked sites are retried through free public CORS relays (`lib/relays.ts`), and the app remembers which relay worked. Only keyless search requests go through them, never your API keys or your Jackett/Prowlarr address. They can see your search terms, may be slow, and can disappear. Turn them off in Settings → Torrent sources.
2. **Your own free relay (reliable and private):**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i7amood1997-arch/Torrent-streaming)

   Tap the button, create or log in to a free Cloudflare account, allow GitHub access, then tap **Deploy**. Paste the resulting `https://….workers.dev` address into **Settings → Advanced → Backend URL**. Your own relay also covers Debrid and subtitle sites, which public relays never handle.

### Publishing updates
Every push to the default branch runs `.github/workflows/pages.yml` (lint → test → build → deploy).
One-time setting: **Settings → Pages → Source: GitHub Actions**.

### Own relay from the command line (alternative to the button)
```bash
npx wrangler login && npx wrangler deploy     # prints https://streamdeck-api.<account>.workers.dev
```
Server-side keys go in with `npx wrangler secret put NAME`. If you store a Debrid key there, also set `ACCESS_TOKEN`.

## Local development

```bash
npm install
npm run dev                  # UI on :3000 (direct mode, no backend)
npm run dev:api              # optional: Worker on :8787 → set NEXT_PUBLIC_API_BASE in .env.local
npm test                     # unit tests (parsers, indexers, subtitles, Worker handler, relays)
```

Build-time settings for the website (optional, in `.env.local` or the Pages workflow):
`NEXT_PUBLIC_API_BASE` sets a default relay URL (empty means direct mode), and `NEXT_PUBLIC_BASE_PATH` sets the sub-path, e.g. `/Torrent-streaming`.
Relay secrets go in `.dev.vars` (local) or `npx wrangler secret put` (deployed).

> There's deliberately no `.env.example`: the Deploy to Cloudflare form would turn its entries into required fields.

On iPhone/iPad: open the site in Safari → Share → **Add to Home Screen**.

## Architecture

```
lib/server/handlers.ts        Fetch-API router, runs in the browser (direct mode) or in the optional Worker: /api/config, /api/search, /api/tmdb,
                              /api/debrid/resolve, /api/subtitles, /api/subtitles/file
                              (CORS allow-list, optional ACCESS_TOKEN)
worker/index.ts               optional Cloudflare Worker entry
lib/cinemeta.ts               keyless catalog (Cinemeta): search, trending, seasons, title → IMDB id
lib/runtime.ts                browser-vs-server differences (CORS-safe headers, error messages)
lib/mkv/                      MKV → fragmented MP4 converter: demuxer (ebml), codec mapping, fMP4 writer, remuxer, MSE player
lib/bt/                       BitTorrent client for the Worker: bencode, HTTP trackers, wire protocol, streaming session
worker/stream-do.ts           Durable Object serving /api/stream/* (torrent → HTTP video)
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
1. **Catalog mode:** text → catalog search (TMDB with a key, otherwise the keyless Cinemeta catalog) → title → (season/episode) → streams by IMDB id.
2. **Fallback:** no TMDB key, a TMDB error, or zero matches → the same text runs as a **raw torrent search**.
3. **Direct Torrent mode** (`⌘/Ctrl + K`): free-text search across text-capable indexers.
4. **Magnet box:** a magnet URI, 40-hex or 32-base32 info-hash, or an `.m3u8`/`.mp4` URL plays immediately. Pasting a magnet into the main search also plays it.

| Indexer   | By IMDB id | By text | Notes |
|-----------|:---:|:---:|---|
| knaben    | — | ✅ | meta-search across many public trackers incl. 1337x and TPB (movies, TV, anime) |
| mediafusion | ✅ | — | public MediaFusion instance (Stremio protocol); may return nothing if the instance hides torrents from anonymous users |
| addons    | ✅ | — | the user's own Stremio add-on manifest URLs (Settings), https only; disable on the relay with `ALLOW_CLIENT_ADDONS=false` |
| animetosho | — | ✅ | anime via its public Torznab feed |
| archive   | ✅ | ✅ | Internet Archive: direct MP4 links to free, legal films (movies only) |
| nyaa      | — | ✅ | anime (RSS) |
| torrentscsv | — | ✅ | open DHT-crawled index |
| torrentio | ✅ | — | Stremio add-on protocol; gives per-file `fileIdx` for season packs |
| torznab   | ✅ | ✅ | Jackett / Prowlarr — reaches 1337x, TorrentGalaxy, etc. through your own instance |
| yts       | ✅ | ✅ | movies |
| eztv      | ✅ | — | series |
| apibay    | — | ✅ | The Pirate Bay API |

Site addresses and query formats are checked against [Prowlarr's maintained definitions](https://github.com/Prowlarr/Indexers); YTS and EZTV fall back across their known mirrors. Enable sources with `INDEXERS` in `wrangler.toml` (comma-separated); set `TORZNAB_URL`/`TORZNAB_API_KEY` as Worker secrets. Your Jackett/Prowlarr must be reachable from the internet for the Worker to use it.

### Direct links (no seeders)
Direct HTTP links appear in their own **Direct links** section above torrents. They start immediately and don't depend on seeders.
- **Sources:** the Internet Archive (free, legal: public-domain and openly licensed films), plus any `url` streams from Stremio add-ons — MediaFusion, and your own add-ons in Settings (e.g. AIOStreams/Comet/MediaFusion configured with a Debrid account, or add-ons whose sources are web links).
- **Playback:** MP4/HLS links play straight from the host. If the host refuses (hotlink protection, CORS), needs request headers (Stremio `proxyHeaders`), or the file is MKV on a browser without MKV support, the link plays through the relay's `/api/proxy`. The proxy supports Range requests (seeking), rewrites HLS playlists so segments and keys also go through it, forwards only `Referer`/`Origin`/`User-Agent`, and accepts the access token as `?t=`.
- **Not supported:** pirate "watch online" sites. They obfuscate and encrypt their links specifically to block other players.

### Streaming engines
- **Built-in streaming through your relay (free, plays in the app):** the Cloudflare Worker runs its own download-only BitTorrent client (`lib/bt/`, `worker/stream-do.ts`). One Durable Object per torrent connects to peers over Cloudflare's outbound TCP sockets, fetches the file list from the magnet, downloads pieces in playback order (each SHA-1 verified), and serves the file as a normal HTTP video with Range support. Nothing is stored; pieces stay in memory only while being watched. It's the default when you have a relay and no Debrid key.
  - Peer management: up to 40 peers, at most 5 connections opening at once (Cloudflare allows about six). Peers that keep us choked for 20 s or go idle are dropped, the slowest peer is replaced every 10 s when better candidates exist, trackers are re-asked every 45 s while peers are scarce, and each peer's request queue is sized to about 1.5 s of its measured speed. The piece a viewer is waiting for is re-requested from faster peers after 2.5 s.
  - In a local test swarm (8 seeders at 300 KB/s each, plus 6 peers that never send data), this delivered 2.41 MB/s against 0.87 MB/s for the earlier 5-peer design.
  - Limits that come from Cloudflare Workers: no UDP (so peers come from HTTP trackers and peer exchange, not DHT) and no transcoding on the relay.
- **MKV on iPhone/iPad (and other browsers without MKV support):** converted in the page as it streams (`lib/mkv/`). A Matroska demuxer reads the file through Range requests; video and audio are repackaged, without re-encoding, into fragmented MP4 and fed to ManagedMediaSource (iOS 17.1+) or MediaSource. Seeking uses the file's Cues index. Embedded text subtitles (SRT/ASS, common in anime) are extracted into the app's subtitle display.
  - Plays: H.264 (8-bit), HEVC, AV1 on devices that decode it, VP9; AAC, AC-3, E-AC-3 (DDP), Opus, MP3.
  - Doesn't play (the app says so and suggests another release): 10-bit H.264 ("Hi10P"), DTS, TrueHD, FLAC-only audio, encrypted tracks.
  - Set `localStorage.mkvDebug = '1'` to log converter decisions to the console.
  - Verified locally against WebTorrent 3 + bittorrent-tracker in Cloudflare's runtime (`wrangler dev`), with a real video played and seeked in the app. Behaviour against public swarms and the free plan's CPU limits is unverified.
- **Free online player (default without a Debrid key):** the app opens [webtor.io](https://webtor.io) with the chosen magnet (`https://webtor.io/ext/magnet?url=<magnet>`, the route webtor's browser extension uses). Webtor's servers download the torrent and stream it to any browser, iPhone Safari included, with no account. They also convert MKV to HLS and can search OpenSubtitles. Trade-offs: it's a third-party service that sees what you play, the free plan streams at up to 5 Mbit/s (fine for 1080p, too slow for 4K), and it uses its own player.
  - It opens as a separate page rather than embedded: webtor's iframe embed fails on iPhone Safari with "CSRF token mismatch", because Safari blocks third-party cookies inside iframes.
  - The app's picked Arabic/English subtitles can be downloaded as `.vtt` (via your relay) and uploaded in webtor's player.
- **Debrid (primary, required on iOS):** adds the magnet, selects the right file (`fileIdx` → `SxxEyy` match → largest video), polls while uncached (progress bar), then returns a direct link. For Real-Debrid, an **HLS transcode** is requested and preferred on iOS, so MKV/HEVC releases still play in Safari.
- **WebTorrent (desktop Chromium/Firefox):** WebRTC peers only, streamed to `<video>` via the service worker. Used automatically when no Debrid key is set.
- Playback: native HLS on Safari, `hls.js` elsewhere, progressive HTTP for files; resume position saved per torrent.

### Subtitles
- Searched by IMDB id with season/episode through the keyless OpenSubtitles feed (the Stremio add-on); with an OpenSubtitles or SubDL key, results are also ranked by similarity to the playing release name. The best **Arabic** and **English** tracks load automatically. For raw search results without an IMDB id, the title is identified through the catalog first.
- **Automatic sync**, in three layers:
  1. **Exact file match.** The playing file's OpenSubtitles hash (size plus first/last 64 KiB, read with two Range requests, `lib/subtitle-hash.ts`) is sent with the search, so subtitles made for that exact release rank first.
  2. **Subtitles inside the video** (MKV text tracks) are preferred when present; they can't drift. MKV converted in the page also gets its 0.5 s timeline shift applied to downloaded subtitles.
  3. **Listening to the audio** (`lib/audio-tap.ts`, `lib/autosync.ts`). While the video plays, speech-band (300–3000 Hz) loudness is sampled 10× per second. Every 15 s the subtitles are cross-correlated against it over ±20 s shifts and the common frame-rate conversions (25↔23.976, 24↔23.976, 25↔24). A result is applied when it's unambiguous and two checks in a row agree; after that it keeps being refined within ±3 s. It needs about a minute of dialogue. Moving the delay slider switches it off for that language; it can also be turned off in the subtitle panel. Audio is only analysed when the browser lets the page read it (in-page MKV conversion, same-origin, or CORS-enabled links), so it never mutes a stream.
- Arabic is decoded from Windows-1256 when not UTF-8, and rendered `dir="rtl"` with Cairo/Tajawal.
- Dual-language display, per-language **sync offset** (±10 s slider, ±100 ms buttons, `[`/`]` keys), size, background opacity, colour and vertical position, plus local `.srt`/`.vtt` upload.
- iPhone system fullscreen can't show HTML overlays, so the cues (with the offset applied) are also exposed as native `<track>`s that switch on in fullscreen.

### Controls
| Desktop | Touch |
|---|---|
| `⌘/Ctrl K` torrent search · `Space`/`K` play · `F` fullscreen · `←/→` ±10 s (`Shift` ±30) · `↑/↓` volume · `M` mute · `C` subtitles · `[ ]` subtitle delay · `P` PiP · click = play, double-click = fullscreen | tap = controls · double-tap left/right = ∓10 s · double-tap centre = play/pause · horizontal drag = scrub |

## Security notes
- API keys entered in Settings live only in the browser's `localStorage`. In direct mode they go straight to the service they belong to. With a backend, they pass through your own Worker, which never stores them.
- Keys stored as **Worker secrets** can be used by anyone who can reach the Worker. Set `ACCESS_TOKEN` (and enter it in Settings) before storing a Debrid key there. `ALLOWED_ORIGINS` stops other websites from calling the Worker from a browser, but it doesn't stop scripts.
- A client-supplied Torznab URL is ignored unless `ALLOW_CLIENT_TORZNAB=true`, so the Worker isn't an open proxy.
- The subtitle download token only accepts OpenSubtitles file ids or SubDL `/subtitle/*.zip` paths.
