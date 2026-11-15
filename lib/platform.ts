'use client';
import { useEffect, useState } from 'react';

/** iPhone/iPad (incl. iPadOS 13+ which reports as MacIntel with touch). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function supportsWebTorrent(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS WebKit has RTCPeerConnection, but WebTorrent's SW streaming + MSE path is
  // unreliable there and Safari kills background tabs; treat it as unsupported.
  return 'RTCPeerConnection' in window && 'serviceWorker' in navigator && !isIOS();
}

export function canPlayHlsNatively(video?: HTMLVideoElement): boolean {
  const v = video ?? (typeof document !== 'undefined' ? document.createElement('video') : undefined);
  return !!v?.canPlayType('application/vnd.apple.mpegurl');
}

export function canPlayMkv(): boolean {
  if (typeof document === 'undefined') return false;
  const v = document.createElement('video');
  // Chromium plays most MKV (H.264/AAC) even though it reports '' for x-matroska; Safari does not.
  return !!v.canPlayType('video/x-matroska') || (/Chrome|Chromium|Edg\//.test(navigator.userAgent) && !isIOS());
}

export function isHlsUrl(url: string, mime?: string) {
  return /\.m3u8(\?|$)/i.test(url) || mime === 'application/vnd.apple.mpegurl' || mime === 'application/x-mpegURL';
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);


export interface PlatformInfo {
  ios: boolean;
  mac: boolean;
  webTorrent: boolean;
  /** Running as an installed home-screen app. */
  standalone: boolean;
}

/** Platform flags resolved after mount (server render assumes a generic desktop). */
export function usePlatform(): PlatformInfo {
  const [p, setP] = useState<PlatformInfo>({ ios: false, mac: false, webTorrent: false, standalone: false });
  useEffect(() => setP({ ios: isIOS(), mac: isMac(), webTorrent: supportsWebTorrent(), standalone: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true }), []);
  return p;
}

/** Can this browser decode Dolby Digital (Plus)? Safari yes; Chrome and Firefox on computers no. */
export function canDecodeDolby(): boolean {
  if (typeof document === 'undefined') return true;
  const v = document.createElement('video');
  const MS = (window as unknown as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
  return !!v.canPlayType('audio/mp4; codecs="ec-3"') || !!MS?.isTypeSupported?.('audio/mp4; codecs="ec-3"');
}

/** Whether a release's audio (from its name) will play here. Unknown audio counts as playable. */
export function audioPlayable(audio: string[] | undefined): boolean {
  if (!audio?.length) return true;
  if (audio.some((a) => a === 'AAC' || a === 'Opus' || a === 'MP3' || a === 'FLAC')) return true;
  if (audio.some((a) => a === 'DDP' || a === 'AC3' || a === 'Atmos')) return canDecodeDolby();
  return false; // DTS / TrueHD: no browser plays these
}
