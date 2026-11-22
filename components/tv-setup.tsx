'use client';
/**
 * TV first run: set the app up from your phone. Shows a QR code (and the same code in letters);
 * the phone that scans it sends its settings through the relay, and the TV takes them in.
 * Also reachable later from Settings → "Set up from your phone".
 */
import { useEffect, useRef, useState } from 'react';
import { api, apiBase } from '@/lib/client-api';
import { BASE_PATH } from '@/lib/config';
import { applyReceived, collect, openPairing, pairLink, type Pairing } from '@/lib/pairing';
import { useApp } from '@/lib/store';
import { onTvBack } from '@/lib/tv';

type Phase = { k: 'opening' } | { k: 'waiting'; p: Pairing; svg: string } | { k: 'expired' } | { k: 'done' } | { k: 'failed'; why: string };

const POLL_MS = 2000;

export function TvSetup() {
  const setDone = useApp((s) => s.setTvSetupDone);
  const [phase, setPhase] = useState<Phase>({ k: 'opening' });
  const [left, setLeft] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const laterRef = useRef<HTMLButtonElement>(null);

  // Back = set up later.
  useEffect(() => onTvBack(() => { setDone(true); return true; }, 50), [setDone]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const relay = apiBase();
    setPhase({ k: 'opening' });
    (async () => {
      if (!relay) { setPhase({ k: 'failed', why: 'This app has no relay yet, so the phone can’t reach it. Set it up later in Settings.' }); return; }
      let p: Pairing;
      try {
        p = await openPairing(relay);
      } catch (e) {
        const status = (e as { status?: number }).status;
        setPhase({ k: 'failed', why: status === 501 ? 'Your relay needs updating before it can pair with a phone.' : 'Couldn’t reach your relay. Check the TV’s internet connection.' });
        return;
      }
      const QR = await import('qrcode');
      const svg = await QR.toString(pairLink(p, location.origin, BASE_PATH), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      if (stop) return;
      setPhase({ k: 'waiting', p, svg });
      const poll = async () => {
        if (stop) return;
        if (Date.now() > p.expires) { setPhase({ k: 'expired' }); return; }
        try {
          const data = await collect(p);
          if (stop) return;
          if (data) {
            applyReceived(data);
            api.loadCaps().catch(() => undefined);
            setPhase({ k: 'done' });
            timer = setTimeout(() => setDone(true), 2200);
            return;
          }
        } catch (e) {
          if ((e as { status?: number }).status === 404) { setPhase({ k: 'expired' }); return; }
          // A network blip: keep trying.
        }
        timer = setTimeout(poll, POLL_MS);
      };
      timer = setTimeout(poll, POLL_MS);
    })();
    return () => { stop = true; clearTimeout(timer); };
  }, [attempt, setDone]);

  // Countdown, and focus on the screen's button so the remote works right away.
  useEffect(() => {
    if (phase.k !== 'waiting') return;
    const tick = () => setLeft(Math.max(0, Math.round((phase.p.expires - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => { laterRef.current?.focus({ preventScroll: true }); }, [phase.k]);

  const code = phase.k === 'waiting' ? `${phase.p.code.slice(0, 4)} ${phase.p.code.slice(4)}` : '';
  return (
    <div role="dialog" aria-label="Set up with your phone" className="fixed inset-0 z-[90] flex items-center justify-center bg-black">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(75,163,255,0.18),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(160,90,255,0.14),transparent_55%)]" />
      <div className="relative grid w-full max-w-5xl grid-cols-[1.1fr_1fr] items-center gap-14 px-14">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-[0.2em] text-white/50">Streamdeck</p>
          {phase.k === 'done' ? (
            <>
              <h1 className="mt-3 text-[40px] font-extrabold leading-tight tracking-tight text-white">You’re all set</h1>
              <p className="mt-3 text-lg text-white/70">Your settings arrived from your phone. Opening Home…</p>
            </>
          ) : (
            <>
              <h1 className="mt-3 text-[40px] font-extrabold leading-tight tracking-tight text-white">Set up with your phone</h1>
              <ol className="mt-6 space-y-3 text-lg text-white/80">
                <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-bold">1</span><span>Open your phone’s camera and point it at the code.</span></li>
                <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-bold">2</span><span>Tap the link, then <b className="text-white">Send to TV</b>.</span></li>
                <li className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-bold">3</span><span>Your relay, Debrid key and subtitle choices appear here.</span></li>
              </ol>
              <p className="mt-5 text-sm text-white/45">No camera? In the app on your phone: Settings → Android TV app → Set up a TV, and type the code.</p>
              <div className="mt-8 flex gap-3">
                {(phase.k === 'expired' || phase.k === 'failed') && (
                  <button className="btn-primary h-12 rounded-full px-7 text-base" onClick={() => setAttempt((x) => x + 1)}>{phase.k === 'expired' ? 'New code' : 'Try again'}</button>
                )}
                <button ref={laterRef} className="btn-glass h-12 rounded-full px-7 text-base" onClick={() => setDone(true)}>Set up later</button>
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col items-center">
          {phase.k === 'waiting' && (
            <>
              <div className="rounded-[28px] bg-white p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                <div className="h-56 w-56 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: phase.svg }} />
              </div>
              <p className="mt-6 font-mono text-[34px] font-bold tracking-[0.18em] text-white">{code}</p>
              <p className="mt-1 text-sm text-white/50">Code expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
            </>
          )}
          {phase.k === 'opening' && <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-white" />}
          {phase.k === 'expired' && <p className="text-center text-lg text-white/70">That code expired.<br />Choose <b className="text-white">New code</b> to get another.</p>}
          {phase.k === 'failed' && <p className="max-w-xs text-center text-lg text-white/70">{phase.why}</p>}
          {phase.k === 'done' && <div className="grid h-28 w-28 place-items-center rounded-full bg-[#30d158]/15 text-6xl text-[#30d158]">✓</div>}
        </div>
      </div>
    </div>
  );
}
