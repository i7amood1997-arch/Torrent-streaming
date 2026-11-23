'use client';
/**
 * Phone side of setting up a TV: opened by scanning the TV's QR code (?pair=CODE&relay=…), or by
 * typing the code in Settings. Shows what will be sent, and sends it when the user agrees.
 */
import { useState } from 'react';
import { apiBase } from '@/lib/client-api';
import { sendToTv, trustedRelays } from '@/lib/pairing';
import { useApp } from '@/lib/store';
import { PAIR_CODE } from '@/lib/sync';

const PROVIDER_NAMES: Record<string, string> = { realdebrid: 'Real-Debrid', torbox: 'TorBox', debridlink: 'Debrid-Link', premiumize: 'Premiumize', alldebrid: 'AllDebrid' };

export function PairSheet({ code, relay, onClose }: { code: string; relay?: string; onClose: () => void }) {
  const s = useApp((x) => x.settings);
  const [state, setState] = useState<'ask' | 'sending' | 'sent' | { error: string }>('ask');
  const to = (relay || apiBase()).replace(/\/+$/, '');
  const trusted = !!to && trustedRelays().includes(to);
  const valid = PAIR_CODE.test(code);
  const host = (() => { try { return new URL(to).host; } catch { return to; } })();
  const key = !!s.debridKeys[s.debridProvider];

  const send = async () => {
    setState('sending');
    try {
      await sendToTv(to, code);
      setState('sent');
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  return (
    <div role="dialog" aria-label="Send your settings" className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-[28px] bg-ink-900 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] ring-1 ring-white/10 md:rounded-[28px]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-600 md:hidden" />
        {state === 'sent' ? (
          <div className="py-4 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#30d158]/15 text-3xl text-[#30d158]">✓</div>
            <h2 className="mt-4 text-xl font-bold text-white">Sent</h2>
            <p className="mt-1 text-sm text-ink-400">The other device should open Home in a moment.</p>
            <button className="btn-primary mt-6 h-12 w-full rounded-full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <h2 className="text-xl font-bold text-white">Send your settings</h2>
            <p className="mt-1 text-sm text-ink-400">Send this device’s settings to the screen showing <b className="font-mono text-white">{code.slice(0, 4)} {code.slice(4)}</b>?</p>
            <ul className="mt-4 divide-y divide-white/[0.07] rounded-2xl bg-ink-800/60 text-sm">
              <li className="flex justify-between gap-4 px-4 py-2.5"><span className="text-ink-400">Relay</span><span className="truncate text-white">{host || 'none'}</span></li>
              <li className="flex justify-between gap-4 px-4 py-2.5"><span className="text-ink-400">{PROVIDER_NAMES[s.debridProvider] ?? 'Debrid'}</span><span className="text-white">{key ? 'Key included' : 'No key'}</span></li>
              <li className="flex justify-between gap-4 px-4 py-2.5"><span className="text-ink-400">Subtitles</span><span className="text-white">{s.subtitle.primaryLang === 'ar' ? 'العربية' : 'English'}{s.subtitle.dual ? ' + second language' : ''}</span></li>
              <li className="flex justify-between gap-4 px-4 py-2.5"><span className="text-ink-400">Sources and keys</span><span className="text-white">{s.indexers.length} sources</span></li>
              <li className="flex justify-between gap-4 px-4 py-2.5"><span className="text-ink-400">Watchlist and history</span><span className="text-white">Kept in sync</span></li>
            </ul>
            {!valid && <p className="mt-3 text-sm text-red-300">That doesn’t look like a TV code (8 letters and numbers).</p>}
            {valid && !trusted && <p className="mt-3 text-sm text-red-300">This code belongs to a relay you don’t use ({host || 'unknown'}), so nothing will be sent.</p>}
            {typeof state === 'object' && <p className="mt-3 text-sm text-red-300">{state.error}</p>}
            <div className="mt-5 flex gap-3">
              <button className="btn-glass h-12 flex-1 rounded-full" onClick={onClose}>Cancel</button>
              <button className="btn-primary h-12 flex-1 rounded-full" disabled={!valid || !trusted || state === 'sending'} onClick={send}>{state === 'sending' ? 'Sending…' : 'Send'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
