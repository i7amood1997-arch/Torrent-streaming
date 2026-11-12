'use client';
/**
 * Free engine: webtor.io embedded player (https://github.com/webtor-io/embed-sdk-js).
 * Webtor's own servers download the torrent and stream it to the browser, so it
 * works on iPhone/iPad Safari with no Debrid account and no computer of your own.
 * Trade-offs: it's a third-party service (it sees what you play), speed depends on
 * its free capacity, and it renders its own player inside an iframe.
 */
import { useEffect, useId, useRef } from 'react';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@webtor/embed-sdk-js@0.2.19/dist/index.min.js';

export interface WebtorSubtitle {
  srclang: string;
  label: string;
  src: string;
  default?: boolean;
}

interface Props {
  magnet: string;
  title?: string;
  imdbId?: string;
  poster?: string;
  subtitles?: WebtorSubtitle[];
  onError?: (message: string) => void;
}

declare global {
  interface Window {
    webtor?: any[] & Record<string, unknown>;
  }
}

let sdkLoading: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise((resolve, reject) => {
    window.webtor = window.webtor || ([] as any);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.charset = 'utf-8';
    s.onload = () => resolve();
    s.onerror = () => { sdkLoading = null; reject(new Error('Could not load the free online player (webtor.io).')); };
    document.head.appendChild(s);
  });
  return sdkLoading;
}

export function WebtorPlayer({ magnet, title, imdbId, poster, subtitles, onError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const baseId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const subsKey = JSON.stringify(subtitles ?? []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Fresh mount point per stream: the SDK replaces the element with its iframe.
    host.innerHTML = '';
    const el = document.createElement('div');
    el.id = `webtor-${baseId}-${Date.now()}`;
    el.className = 'webtor h-full w-full';
    host.appendChild(el);

    let cancelled = false;
    const queue = (window.webtor = window.webtor || ([] as any));
    queue.push({
      id: el.id,
      magnet,
      title,
      imdbId,
      poster,
      width: '100%',
      height: '100%',
      lang: 'en',
      subtitles: subtitles?.length ? subtitles : undefined,
      on: (e: { name: string; data?: unknown }) => {
        if (!cancelled && e.name === (window.webtor as any)?.TORRENT_ERROR) onError?.('The free online player could not load this torrent (no peers or unsupported). Try another result.');
      },
    });
    loadSdk().catch((err) => !cancelled && onError?.(err.message));
    return () => {
      cancelled = true;
      host.innerHTML = '';
    };
  }, [magnet, title, imdbId, poster, subsKey, baseId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full [&_iframe]:border-0" />;
}
