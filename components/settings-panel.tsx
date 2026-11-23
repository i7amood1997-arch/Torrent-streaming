'use client';
/**
 * Settings: API keys (stored only in this browser's localStorage and sent per
 * request to this app's own API routes), engine preference, indexer info.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { asset, DEFAULT_API_BASE } from '@/lib/config';
import { useApp, type EnginePref } from '@/lib/store';
import { usePlatform } from '@/lib/platform';
import type { DebridProvider } from '@/lib/types';
import { isTV } from '@/lib/tv';
import { lastSync, syncSoon } from '@/lib/sync-client';
import { alertState, disableAlerts, enableAlerts, testAlert, type AlertState } from '@/lib/alerts';
import { SYNC_KEY } from '@/lib/sync';
import { PairSheet } from './pair-sheet';
import { Disclosure, Row, Section, Segmented, Switch } from './ui';

const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/i7amood1997-arch/Torrent-streaming';

const SOURCES = [
  { id: 'torrentio', name: 'Torrentio', help: 'Catalog mode: many trackers at once for movies, shows and anime.' },
  { id: 'knaben', name: 'Knaben', help: 'Search engine across many public trackers (movies, TV, anime).' },
  { id: 'yts', name: 'YTS', help: 'Movies in MP4 — the format iPhone plays directly.' },
  { id: 'eztv', name: 'EZTV', help: 'TV episodes (Catalog mode).' },
  { id: 'nyaa', name: 'Nyaa', help: 'Anime.' },
  { id: 'animetosho', name: 'AnimeTosho', help: 'Anime from Nyaa, TokyoTosho and AniDex, with seeders.' },
  { id: 'archive', name: 'Internet Archive', help: 'Free, legal films (public domain and openly licensed), streamed directly — no seeders.' },
  { id: 'torrentsdb', name: 'TorrentsDB', help: 'Large catalogue of movies, shows and anime (Catalog mode), like Torrentio.' },
  { id: 'bitsearch', name: 'Bitsearch', help: 'Large search engine across many sites, with seeders.' },
  { id: 'mediafusion', name: 'MediaFusion', help: 'Big aggregator (Prowlarr, Zilean, Torrentio…). Its public server may hide torrents from free users.' },
  { id: 'apibay', name: 'The Pirate Bay API', help: 'Text search of all video.' },
  { id: 'torrentscsv', name: 'Torrents-CSV', help: 'Open index built from the DHT network.' },
  { id: 'torznab', name: 'Jackett / Prowlarr', help: 'Your own indexer manager (Torznab).' },
];

const PROVIDERS: { id: DebridProvider; name: string; help: string }[] = [
  { id: 'realdebrid', name: 'Real-Debrid', help: 'real-debrid.com/apitoken' },
  { id: 'torbox', name: 'TorBox', help: 'torbox.app/settings → API key' },
  { id: 'debridlink', name: 'Debrid-Link', help: 'debrid-link.com/webapp/apikey' },
  { id: 'premiumize', name: 'Premiumize', help: 'premiumize.me/account (API key)' },
  { id: 'alldebrid', name: 'AllDebrid', help: 'alldebrid.com/apikeys' },
];

const ServerBadge = ({ on }: { on?: boolean }) =>
  on ? <span className="ml-2 rounded bg-hd/15 px-1.5 py-0.5 text-[10px] font-semibold text-hd">set on relay</span> : null;

function KeyField({ label, hint, value, onChange }: { label: string; hint?: React.ReactNode; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block px-4 py-3">
      <span className="block text-sm text-ink-200">{label}</span>
      <input type="password" autoComplete="off" spellCheck={false} className="input mt-2 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value.trim())} />
      {hint && <span className="mt-1.5 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

/** New-episode alerts (phones, tablets, computers): a switch, and a test notification. */
function AlertsSection() {
  const caps = useApp((s) => s.caps);
  const [state, setState] = useState<AlertState>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  useEffect(() => { alertState().then(setState).catch(() => setState('unsupported')); }, []);
  if (!state || state === 'unsupported') return null;
  const relayOk = !!caps?.sync && !caps.offline;
  const flip = async (on: boolean) => {
    setBusy(true); setMsg(undefined);
    try {
      if (on) { await enableAlerts(); setMsg('On. You’ll hear about new episodes of the shows in My List and the ones you’re watching.'); }
      else await disableAlerts();
    } catch (e) { setMsg((e as Error).message); }
    setState(await alertState().catch(() => 'off' as const));
    setBusy(false);
  };
  const hint = state === 'needs-home-screen' ? 'On iPhone and iPad: add Streamdeck to your Home Screen (Share → Add to Home Screen), open it from there, then turn this on.'
    : state === 'blocked' ? 'Notifications are blocked for this app. Allow them in your device’s settings, then come back.'
    : !relayOk ? 'Needs your relay, updated to the latest version.' : 'A notification when a show you follow has a new episode (checked every few hours by your relay).';
  return (
    <Section title="New-episode alerts" footer={msg ?? hint}>
      <Row label="Notify me">
        <Switch checked={state === 'on'} disabled={busy || !relayOk || state === 'needs-home-screen' || state === 'blocked'} onChange={flip} label="New-episode alerts" />
      </Row>
      {state === 'on' && (
        <Row label="Send a test" onClick={() => { setMsg(undefined); testAlert().then((r) => setMsg(r.sent ? 'Sent. It should appear in a moment.' : 'Couldn’t reach this device. Turn alerts off and on again.')).catch((e) => setMsg(e.message)); }}>
          <span className="text-xs text-accent">Test</span>
        </Row>
      )}
    </Section>
  );
}

/** Sync between devices: status, the shared key, and taking another device's key. */
function SyncSection() {
  const { settings, updateSettings, caps } = useApp();
  const [draft, setDraft] = useState<string>();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 3000); return () => clearInterval(t); }, []);
  const state = !caps || caps.direct ? { text: 'Needs a relay', tone: 'bg-ink-700 text-ink-400' }
    : caps.offline ? { text: 'Relay not reachable', tone: 'bg-red-500/15 text-red-300' }
    : !caps.sync ? { text: 'Update your relay', tone: 'bg-ink-700 text-ink-400' }
    : lastSync && !lastSync.ok ? { text: 'Not syncing', tone: 'bg-red-500/15 text-red-300' }
    : { text: lastSync ? 'On' : 'Starting', tone: 'bg-hd/15 text-hd' };
  const value = draft ?? settings.syncKey;
  const [onTv, setOnTv] = useState(true);
  useEffect(() => setOnTv(isTV()), []);
  const valid = SYNC_KEY.test(value);
  return (
    <Section title="Sync between devices" footer="My List, Continue Watching, where you stopped and each show’s subtitle choices follow you to every device with the same sync key. Setting up a TV from your phone gives it this key; on another phone, tablet or computer, paste it below.">
      <Row label="Status"><span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${state.tone}`}>{state.text}</span></Row>
      <label className="block px-4 py-3">
        <span className="block text-sm text-ink-200">Sync key</span>
        <span className="mt-2 flex gap-2">
          <input className="input flex-1 font-mono text-xs" spellCheck={false} autoComplete="off" value={value} placeholder="Made automatically once your relay is connected"
            onChange={(e) => setDraft(e.target.value.trim().toLowerCase())} aria-label="Sync key" />
          {draft != null && draft !== settings.syncKey ? (
            <button type="button" className="btn-primary rounded-full px-4" disabled={!valid} onClick={() => { updateSettings({ syncKey: draft }); setDraft(undefined); syncSoon(); }}>Use</button>
          ) : (
            <button type="button" className="btn-glass rounded-full px-4" disabled={!settings.syncKey} onClick={() => navigator.clipboard?.writeText(settings.syncKey).catch(() => undefined)}>Copy</button>
          )}
        </span>
        {draft != null && draft !== settings.syncKey && !valid && <span className="mt-1.5 block text-xs text-red-300/90">A sync key is 32 letters and digits (0–9, a–f).</span>}
        {lastSync?.error && <span className="mt-1.5 block text-xs text-red-300/90">{lastSync.error}</span>}
      </label>
      <Row label="Sync now" onClick={() => syncSoon()}><span className="text-xs text-accent">Sync</span></Row>
      {!onTv && (
        <Row label="Copy settings from your phone" hint="Shows a code to scan with the phone that has your settings: this device gets them, and the same sync key." onClick={() => useApp.getState().setLinking(true)}>
          <span className="text-xs text-accent">Open</span>
        </Row>
      )}
    </Section>
  );
}

export function SettingsPanel() {
  const { settings, updateSettings, updateSubtitleStyle, caps } = useApp();
  const platform = usePlatform();
  const sub = settings.subtitle;
  const provider = PROVIDERS.find((p) => p.id === settings.debridProvider)!;
  const relay = !caps || caps.direct ? { text: 'Not set up', tone: 'bg-ink-700 text-ink-400' } : caps.offline ? { text: 'Not reachable', tone: 'bg-red-500/15 text-red-300' } : { text: 'Connected', tone: 'bg-hd/15 text-hd' };
  const [apkAddress, setApkAddress] = useState(asset('/tv.apk'));
  useEffect(() => setApkAddress(`${location.host}${asset('/tv.apk')}`), []);
  const sourcesOn = SOURCES.filter((s) => settings.indexers.includes(s.id)).length;
  const [tv, setTv] = useState(false);
  useEffect(() => setTv(isTV()), []);
  const setTvSetupDone = useApp((s) => s.setTvSetupDone);
  const [tvCode, setTvCode] = useState('');
  const [pairOpen, setPairOpen] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-7 pb-8">
      {platform.ios && !platform.standalone && (
        <p className="rounded-2xl bg-accent/10 px-4 py-3 text-sm text-ink-200">
          <b>Tip:</b> tap <span className="text-accent">Share</span> → <span className="text-accent">Add to Home Screen</span> to use Streamdeck as a full-screen app.
        </p>
      )}

      <Section title="Playback" footer="Auto uses your Debrid account when a key is set, otherwise your relay streams the torrent for free.">
        <Row label="Stream with">
          <select className="input w-auto max-w-[11rem] py-1.5 text-sm" value={settings.engine} onChange={(e) => updateSettings({ engine: e.target.value as EnginePref })} aria-label="Streaming engine">
            <option value="auto">Auto</option>
            <option value="debrid">Debrid</option>
            <option value="cloud" disabled={!caps?.stream}>Your relay (free)</option>
            <option value="webtor">webtor.io (free)</option>
            <option value="webtorrent" disabled={!platform.webTorrent}>WebTorrent</option>
          </select>
        </Row>
        <Row label="Service">
          {/* Five services don't fit side by side on a phone: a list instead. */}
          <select className="input w-auto max-w-[11rem] py-1.5 text-sm" aria-label="Debrid service" value={settings.debridProvider}
            onChange={(e) => updateSettings({ debridProvider: e.target.value as DebridProvider })}>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Row>
        <KeyField label={`${provider.name} API key`} hint={<>Find it at {provider.help}<ServerBadge on={caps?.debrid[provider.id]} /></>}
          value={settings.debridKeys[provider.id]} onChange={(v) => updateSettings({ debridKeys: { ...settings.debridKeys, [provider.id]: v } })} />
      </Section>

      <Section title="Subtitles">
        <Row label="Main language">
          <Segmented label="Main subtitle language" size="sm" value={sub.primaryLang} onChange={(v) => updateSubtitleStyle({ primaryLang: v })}
            options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} />
        </Row>
        <Row label="Show both languages"><Switch checked={sub.dual} onChange={(v) => updateSubtitleStyle({ dual: v })} label="Show both languages" /></Row>
        <Row label="Sync to the audio" hint="Lines subtitles up with the dialogue automatically."><Switch checked={sub.autoSync} onChange={(v) => updateSubtitleStyle({ autoSync: v })} label="Sync to the audio" /></Row>
<Row wrap label="Translator" hint={caps?.ai ? 'AI reads the lines in context: more natural Arabic. It uses your relay’s free daily allowance; Google takes over when that runs out.' : 'AI translation needs your relay, updated to the latest version.'}>
          <Segmented label="Translator" size="sm" value={sub.translator} onChange={(v) => updateSubtitleStyle({ translator: v })}
            options={[{ value: 'ai', label: 'AI (best)' }, { value: 'google', label: 'Google' }]} />
        </Row>
        <Row label="Translate when missing" hint="No Arabic or English subtitles? Translate them from another language."><Switch checked={sub.autoTranslate} onChange={(v) => updateSubtitleStyle({ autoTranslate: v })} label="Translate when missing" /></Row>
        <Row label="Make from the audio" hint={caps?.ai ? 'No subtitles at all? Your relay writes them from the speech (free daily allowance).' : 'Needs your relay, updated to the latest version.'}>
          <Switch checked={sub.autoGenerate} onChange={(v) => updateSubtitleStyle({ autoGenerate: v })} label="Make from the audio" />
        </Row>
      </Section>

      <Section title="Your relay" footer={<>Your own free Cloudflare relay unblocks sources, streams torrents and makes subtitles from speech. Only you use it.</>}>
        <Row label="Status"><span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${relay.tone}`}>{relay.text}</span></Row>
        <label className="block px-4 py-3">
          <span className="block text-sm text-ink-200">Relay address</span>
          <input className="input mt-2 font-mono text-xs" inputMode="url" placeholder={DEFAULT_API_BASE || 'https://streamdeck-api.<account>.workers.dev'} value={settings.apiBase} onChange={(e) => updateSettings({ apiBase: e.target.value.trim() })} />
          {caps?.offline && <span className="mt-1.5 block text-xs text-red-300/90">{caps.offline}</span>}
        </label>
        <KeyField label="Access token" hint={caps?.accessToken ? 'This relay requires a token.' : 'Only if you set ACCESS_TOKEN on your relay.'} value={settings.accessToken} onChange={(v) => updateSettings({ accessToken: v })} />
        <Row label="Test the connection" onClick={() => api.loadCaps()}><span className="text-xs text-accent">Test</span></Row>
      </Section>
      <Disclosure title="Set up a relay (5 minutes, free)">
        <div className="space-y-3 rounded-2xl bg-ink-900 p-4 text-sm ring-1 ring-white/[0.06]">
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-ink-200">
            <li>Tap <b>Deploy to Cloudflare</b>.</li>
            <li>Create a free Cloudflare account (or log in) and allow it to use your GitHub.</li>
            <li>Tap <b>Deploy</b> and wait about a minute.</li>
            <li>Copy the address ending in <code>.workers.dev</code> into <b>Relay address</b> above.</li>
          </ol>
          <a className="btn-primary w-full" href={DEPLOY_URL} target="_blank" rel="noopener noreferrer">Deploy to Cloudflare</a>
        </div>
      </Disclosure>

      <SyncSection />
      {!tv && <AlertsSection />}
      {tv && (
        <Section footer="Shows a code to scan with your phone, which sends its settings here.">
          <Row label="Set up from your phone" onClick={() => setTvSetupDone(false)}><span className="text-xs text-accent">Open</span></Row>
        </Section>
      )}
      <Disclosure title="Android TV app">
      {!tv && (
        <Section title="Set up a TV or another device" footer="Type the code it shows (the TV app on its first screen; other devices in Settings → Copy settings from your phone), or scan its QR code with your camera. Your settings go to it through your relay.">
          <form className="flex gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (tvCode.length === 8) setPairOpen(true); }}>
            <input className="input flex-1 font-mono uppercase tracking-[0.2em]" placeholder="ABCD EFGH" maxLength={9} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              value={tvCode} onChange={(e) => setTvCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} aria-label="TV code" />
            <button type="submit" className="btn-primary rounded-full px-5" disabled={tvCode.length !== 8}>Next</button>
          </form>
        </Section>
      )}
      {pairOpen && <PairSheet code={tvCode} onClose={() => { setPairOpen(false); setTvCode(''); }} />}
      <Section footer={<>Updates install over the previous version. The app opens this site full screen, works with the remote, and plays files the TV’s browser can’t handle (for example MKV with Dolby audio) in the TV’s own player, with your subtitles.</>}>
        <div className="space-y-2 px-4 py-3 text-sm text-ink-200">
          <p>1. On the TV, install <b>Downloader</b> (by AFTVnews) from the Play Store.</p>
          <p>2. Open it and type this address:</p>
          <p className="select-all rounded-lg bg-ink-800 px-3 py-2 font-mono text-[13px] text-white">{apkAddress}</p>
          <p>3. Allow Downloader to install apps when asked, then tap <b>Install</b>.</p>
        </div>
        <Row label="Download the app here" onClick={() => { location.href = asset('/tv.apk'); }}><span className="text-xs text-white">.apk</span></Row>
      </Section>
      </Disclosure>

      <Disclosure title={`Torrent sources · ${sourcesOn} on`}>
        <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
          {SOURCES.map((src) => {
            const on = settings.indexers.includes(src.id);
            const offered = !caps || caps.indexers.includes(src.id) || (src.id === 'torznab' && caps.clientTorznab);
            return (
              <Row key={src.id} label={src.name} hint={src.help}>
                <Switch checked={on} disabled={!offered} label={src.name}
                  onChange={(v) => updateSettings({ indexers: v ? [...settings.indexers, src.id] : settings.indexers.filter((i) => i !== src.id) })} />
              </Row>
            );
          })}
          {caps?.direct && (
            <Row label="Public relays when blocked" hint="Free third-party relays retry blocked sources. They can see what you search (never your keys).">
              <Switch checked={settings.publicRelays} onChange={(v) => updateSettings({ publicRelays: v })} label="Use public relays" />
            </Row>
          )}
        </div>
        {settings.indexers.includes('torznab') && (caps?.clientTorznab ? (
          <div className="mt-3 divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
            <label className="block px-4 py-3"><span className="block text-sm text-ink-200">Jackett / Prowlarr Torznab URL</span>
              <input className="input mt-2 font-mono text-xs" value={settings.torznabUrl} onChange={(e) => updateSettings({ torznabUrl: e.target.value.trim() })} /></label>
            <KeyField label="Torznab API key" value={settings.torznabKey} onChange={(v) => updateSettings({ torznabKey: v })} />
          </div>
        ) : <p className="mt-2 px-1 text-xs text-ink-400">Torznab is configured on the relay (<code>TORZNAB_URL</code>).</p>)}
        <label className="mt-3 block rounded-2xl bg-ink-900 px-4 py-3 ring-1 ring-white/[0.06]">
          <span className="block text-sm text-ink-200">Your Stremio add-ons</span>
          <span className="mt-0.5 block text-xs text-ink-400">One manifest link per line (AIOStreams, Comet, MediaFusion…). Their results join every catalog search.</span>
          <textarea className="input mt-2 min-h-[72px] font-mono text-xs" spellCheck={false} placeholder="https://…/manifest.json" value={settings.stremioAddons} onChange={(e) => updateSettings({ stremioAddons: e.target.value })} />
        </label>
      </Disclosure>

      <Disclosure title="Optional keys">
        <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
          <KeyField label="TMDB API key" hint={<>Not needed: the catalog works without it.<ServerBadge on={caps?.tmdb} /></>} value={settings.tmdbKey} onChange={(v) => updateSettings({ tmdbKey: v })} />
          <KeyField label="OpenSubtitles API key" hint={<>Not needed. Adds more release-matched subtitles.<ServerBadge on={caps?.subtitles.opensubtitles} /></>} value={settings.openSubtitlesKey} onChange={(v) => updateSettings({ openSubtitlesKey: v })} />
          <KeyField label="SubDL API key (recommended for Arabic)" hint={<>The largest collection of Arabic subtitles made by people (including the old Subscene archive), so fewer need machine translation. Free key: subdl.com/panel/api<ServerBadge on={caps?.subtitles.subdl} /></>} value={settings.subdlKey} onChange={(v) => updateSettings({ subdlKey: v })} />
        </div>
      </Disclosure>

      <p className="px-1 text-xs leading-relaxed text-ink-400">
        Keys stay in this browser and go only to the service they belong to (or your own relay). Only stream content you have the rights to access; you are responsible for complying with the laws of your country.
      </p>
    </div>
  );
}
