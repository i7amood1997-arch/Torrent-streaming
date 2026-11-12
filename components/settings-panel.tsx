'use client';
/**
 * Settings: API keys (stored only in this browser's localStorage and sent per
 * request to this app's own API routes), engine preference, indexer info.
 */
import { useApp, type EnginePref } from '@/lib/store';
import { usePlatform } from '@/lib/platform';
import type { DebridProvider } from '@/lib/types';

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
        <Field label="Engine" hint={platform.webTorrent ? 'Auto: Debrid when a key is set, otherwise in-browser WebTorrent.' : 'This device cannot use WebTorrent — a Debrid key is required.'}>
          <select className="input" value={settings.engine} onChange={(e) => updateSettings({ engine: e.target.value as EnginePref })}>
            <option value="auto">Auto</option>
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
        <Field label="TMDB API key / read token" hint={<>themoviedb.org → Settings → API<ServerBadge on={caps?.tmdb} /></>}>
          <input {...secret} value={settings.tmdbKey} onChange={(e) => updateSettings({ tmdbKey: e.target.value.trim() })} />
        </Field>
        <Field label="OpenSubtitles API key" hint={<>opensubtitles.com/consumers<ServerBadge on={caps?.subtitles.opensubtitles} /></>}>
          <input {...secret} value={settings.openSubtitlesKey} onChange={(e) => updateSettings({ openSubtitlesKey: e.target.value.trim() })} />
        </Field>
        <Field label="SubDL API key" hint={<>subdl.com/panel/api<ServerBadge on={caps?.subtitles.subdl} /></>}>
          <input {...secret} value={settings.subdlKey} onChange={(e) => updateSettings({ subdlKey: e.target.value.trim() })} />
        </Field>
      </section>

      <section className="card space-y-4 p-4">
        <h3 className="font-semibold text-white">Indexers</h3>
        <p className="text-sm text-ink-400">Enabled on server: <span className="text-ink-200">{caps?.indexers.join(', ') || '—'}</span></p>
        {caps?.clientTorznab ? (
          <>
            <Field label="Torznab URL (Jackett / Prowlarr)" hint="e.g. http://host:9117/api/v2.0/indexers/all/results/torznab">
              <input className="input font-mono text-xs" value={settings.torznabUrl} onChange={(e) => updateSettings({ torznabUrl: e.target.value.trim() })} />
            </Field>
            <Field label="Torznab API key">
              <input {...secret} value={settings.torznabKey} onChange={(e) => updateSettings({ torznabKey: e.target.value.trim() })} />
            </Field>
          </>
        ) : (
          <p className="text-xs text-ink-400">Configure Jackett/Prowlarr with <code>TORZNAB_URL</code> / <code>TORZNAB_API_KEY</code> on the server (or set <code>ALLOW_CLIENT_TORZNAB=true</code> to enter it here).</p>
        )}
      </section>

      {platform.ios && (
        <section className="card p-4 text-sm text-ink-200">
          <b>Install on iPhone/iPad:</b> tap <span className="text-accent">Share</span> → <span className="text-accent">Add to Home Screen</span> for full-screen app mode.
        </section>
      )}

      <p className="text-xs leading-relaxed text-ink-400">
        Keys are stored only in this browser and are sent to this app’s own server routes, which forward them to the provider. Only stream content you have the rights to access; you are responsible for complying with the laws of your country.
      </p>
    </div>
  );
}
