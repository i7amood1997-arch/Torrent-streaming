'use client';
/**
 * Settings: API keys (stored only in this browser's localStorage and sent per
 * request to this app's own API routes), engine preference, indexer info.
 */
import { api } from '@/lib/client-api';
import { DEFAULT_API_BASE } from '@/lib/config';
import { useApp, type EnginePref } from '@/lib/store';
import { usePlatform } from '@/lib/platform';
import type { DebridProvider } from '@/lib/types';

const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/i7amood1997-arch/Torrent-streaming';

const SOURCES = [
  { id: 'torrentio', name: 'Torrentio', help: 'Catalog mode: many trackers at once for movies, shows and anime.' },
  { id: 'knaben', name: 'Knaben', help: 'Search engine across many public trackers (movies, TV, anime).' },
  { id: 'yts', name: 'YTS', help: 'Movies in MP4 — the format iPhone plays directly.' },
  { id: 'eztv', name: 'EZTV', help: 'TV episodes (Catalog mode).' },
  { id: 'nyaa', name: 'Nyaa', help: 'Anime.' },
  { id: 'apibay', name: 'The Pirate Bay API', help: 'Text search of all video.' },
  { id: 'torrentscsv', name: 'Torrents-CSV', help: 'Open index built from the DHT network.' },
  { id: 'torznab', name: 'Jackett / Prowlarr', help: 'Your own indexer manager (Torznab).' },
];

const PROVIDERS: { id: DebridProvider; name: string; help: string }[] = [
  { id: 'realdebrid', name: 'Real-Debrid', help: 'real-debrid.com/apitoken' },
  { id: 'torbox', name: 'TorBox', help: 'torbox.app/settings → API key' },
  { id: 'debridlink', name: 'Debrid-Link', help: 'debrid-link.com/webapp/apikey' },
];

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

const ServerBadge = ({ on }: { on?: boolean }) =>
  on ? <span className="ml-2 rounded bg-hd/15 px-1.5 py-0.5 text-[10px] font-semibold text-hd">server key set</span> : null;

export function SettingsPanel() {
  const { settings, updateSettings, caps } = useApp();
  const platform = usePlatform();
  const secret = { type: 'password', autoComplete: 'off', spellCheck: false, className: 'input font-mono text-xs' } as const;

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-8">
      <h2 className="text-lg font-semibold text-white">Settings</h2>

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold text-white">Streaming engine</h3>
        <Field label="Engine" hint="Free: your own relay downloads the torrent and plays it here in the app (MKV is converted on the fly on iPhone). A paid Debrid key is faster and handles every format.">
          <select className="input" value={settings.engine} onChange={(e) => updateSettings({ engine: e.target.value as EnginePref })}>
            <option value="auto">Auto (Debrid key → your relay → free online player)</option>
            <option value="cloud" disabled={!caps?.stream}>Built-in streaming (your relay, free, plays in the app)</option>
            <option value="webtor">Free online player (webtor.io, separate tab)</option>
            <option value="debrid">Debrid (HTTP / HLS)</option>
            <option value="webtorrent" disabled={!platform.webTorrent}>WebTorrent (WebRTC, desktop)</option>
          </select>
        </Field>
        <Field label="Debrid provider">
          <div className="grid grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" onClick={() => updateSettings({ debridProvider: p.id })}
                className={`btn border ${settings.debridProvider === p.id ? 'border-accent bg-accent-soft text-accent' : 'border-ink-600 text-ink-400'}`}>
                {p.name}
              </button>
            ))}
          </div>
        </Field>
        {PROVIDERS.filter((p) => p.id === settings.debridProvider).map((p) => (
          <Field key={p.id} label={`${p.name} API key`} hint={<>Get it at {p.help}<ServerBadge on={caps?.debrid[p.id]} /></>}>
            <input {...secret} value={settings.debridKeys[p.id]} onChange={(e) => updateSettings({ debridKeys: { ...settings.debridKeys, [p.id]: e.target.value.trim() } })} />
          </Field>
        ))}
      </section>

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold text-white">Metadata & subtitles</h3>
        <Field label="TMDB API key / read token (optional)" hint={<>Not required: the catalog works without it. themoviedb.org → Settings → API<ServerBadge on={caps?.tmdb} /></>}>
          <input {...secret} value={settings.tmdbKey} onChange={(e) => updateSettings({ tmdbKey: e.target.value.trim() })} />
        </Field>
        <Field label="OpenSubtitles API key (optional)" hint={<>Not required: Arabic and English subtitles load without it. A key adds release-matched results. opensubtitles.com/consumers<ServerBadge on={caps?.subtitles.opensubtitles} /></>}>
          <input {...secret} value={settings.openSubtitlesKey} onChange={(e) => updateSettings({ openSubtitlesKey: e.target.value.trim() })} />
        </Field>
        <Field label="SubDL API key (optional)" hint={<>subdl.com/panel/api<ServerBadge on={caps?.subtitles.subdl} /></>}>
          <input {...secret} value={settings.subdlKey} onChange={(e) => updateSettings({ subdlKey: e.target.value.trim() })} />
        </Field>
      </section>

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold text-white">Torrent sources</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOURCES.map((src) => {
            const on = settings.indexers.includes(src.id);
            const offered = !caps || caps.indexers.includes(src.id) || (src.id === 'torznab' && caps.clientTorznab);
            return (
              <label key={src.id} className={`flex items-start gap-3 rounded-lg border p-3 ${on ? 'border-accent/50 bg-accent/5' : 'border-ink-700'} ${offered ? '' : 'opacity-40'}`}>
                <input type="checkbox" className="mt-1" disabled={!offered} checked={on}
                  onChange={(e) => updateSettings({ indexers: e.target.checked ? [...settings.indexers, src.id] : settings.indexers.filter((i) => i !== src.id) })} />
                <span>
                  <span className="block text-sm font-medium text-ink-200">{src.name}</span>
                  <span className="block text-xs text-ink-400">{src.help}</span>
                </span>
              </label>
            );
          })}
        </div>
        {caps?.direct && (
          <label className="flex items-start gap-3 rounded-lg border border-ink-700 p-3">
            <input type="checkbox" className="mt-1" checked={settings.publicRelays} onChange={(e) => updateSettings({ publicRelays: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium text-ink-200">Use public relays when a site is blocked</span>
              <span className="block text-xs text-ink-400">
                Free third-party services that fetch blocked sites for you. They can see what you search (never your keys),
                and may be slow or stop working. For a private, reliable relay, set up your own below.
              </span>
            </span>
          </label>
        )}
        {settings.indexers.includes('torznab') && (caps?.clientTorznab ? (
          <div className="grid gap-3">
            <Field label="Jackett / Prowlarr Torznab URL" hint="Must be https:// and reachable from the internet, e.g. https://host/api/v2.0/indexers/all/results/torznab">
              <input className="input font-mono text-xs" value={settings.torznabUrl} onChange={(e) => updateSettings({ torznabUrl: e.target.value.trim() })} />
            </Field>
            <Field label="Torznab API key">
              <input {...secret} value={settings.torznabKey} onChange={(e) => updateSettings({ torznabKey: e.target.value.trim() })} />
            </Field>
          </div>
        ) : (
          <p className="text-xs text-ink-400">Torznab is configured on the backend (<code>TORZNAB_URL</code>).</p>
        ))}
      </section>

      {platform.ios && (
        <section className="card p-4 text-sm text-ink-200">
          <b>Install on iPhone/iPad:</b> tap <span className="text-accent">Share</span> → <span className="text-accent">Add to Home Screen</span> for full-screen app mode.
        </section>
      )}

      <section className="card space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-white">Advanced: own backend <span className="font-normal text-ink-400">(optional)</span></h3>
          <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${!caps || caps.direct ? 'bg-ink-700 text-ink-400' : caps.offline ? 'bg-red-500/15 text-red-300' : 'bg-hd/15 text-hd'}`}>
            {!caps ? 'checking…' : caps.direct ? 'not needed' : caps.offline ? 'not connected' : 'connected'}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-ink-400">
          If sources say “blocked” or “unreachable”, your own free relay fixes it reliably and privately (only you use it).
          One time, about 5 minutes, no coding:
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-ink-200">
          <li>Tap <b>Deploy to Cloudflare</b> below.</li>
          <li>Create a free Cloudflare account (or log in) and allow it to use your GitHub.</li>
          <li>Tap <b>Deploy</b> and wait about a minute.</li>
          <li>Copy the address that ends in <code>.workers.dev</code> and paste it into <b>Backend URL</b> below.</li>
        </ol>
        <a className="btn-primary w-full sm:w-auto" href={DEPLOY_URL} target="_blank" rel="noopener noreferrer">Deploy to Cloudflare (free)</a>
        {caps?.offline && <p className="text-xs text-red-300/90">{caps.offline}</p>}
        <Field label="Backend URL" hint={<>Paste your <code>.workers.dev</code> address here. Leave empty to use the app without one.{DEFAULT_API_BASE && <> Leave empty to use the default: <code className="break-all">{DEFAULT_API_BASE}</code></>}</>}>
          <input className="input font-mono text-xs" inputMode="url" placeholder={DEFAULT_API_BASE || 'https://streamdeck-api.<account>.workers.dev'} value={settings.apiBase} onChange={(e) => updateSettings({ apiBase: e.target.value.trim() })} />
        </Field>
        <Field label="Access token" hint={caps?.accessToken ? 'This backend requires a token.' : 'Leave empty unless you set an ACCESS_TOKEN on your relay.'}>
          <input {...secret} value={settings.accessToken} onChange={(e) => updateSettings({ accessToken: e.target.value.trim() })} />
        </Field>
        <button type="button" className="btn-ghost border border-ink-600" onClick={() => api.loadCaps()}>Test connection</button>
      </section>

      <p className="text-xs leading-relaxed text-ink-400">
        Keys are stored only in this browser and are sent only to the service they belong to (or to your own backend, if you set one). Only stream content you have the rights to access; you are responsible for complying with the laws of your country.
      </p>
    </div>
  );
}
