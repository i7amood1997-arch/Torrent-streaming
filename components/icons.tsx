import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 20, ...p }: P) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconSearch = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const IconPlay = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><path d="M7 4.5v15l13-7.5z" /></svg>;
export const IconPause = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>;
export const IconMagnet = (p: P) => <svg {...base(p)}><path d="M6 15V9a6 6 0 0 1 12 0v6" /><path d="M6 15a6 6 0 0 0 12 0" /><path d="M6 11h4M14 11h4" /></svg>;
export const IconFilm = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></svg>;
export const IconList = (p: P) => <svg {...base(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
export const IconTv = (p: P) => <svg {...base(p)}><rect x="2" y="5" width="20" height="13" rx="2" /><path d="m8 21 4-3 4 3" /></svg>;
export const IconSettings = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
export const IconFilter = (p: P) => <svg {...base(p)}><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg>;
export const IconX = (p: P) => <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const IconSeed = (p: P) => <svg {...base(p)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
export const IconLeech = (p: P) => <svg {...base(p)}><path d="M12 5v14M19 12l-7 7-7-7" /></svg>;
export const IconCC = (p: P) => <svg {...base(p)}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" /></svg>;
export const IconExpand = (p: P) => <svg {...base(p)}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
export const IconShrink = (p: P) => <svg {...base(p)}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
export const IconVolume = (p: P) => <svg {...base(p)}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
export const IconMute = (p: P) => <svg {...base(p)}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m22 9-6 6M16 9l6 6" /></svg>;
export const IconPip = (p: P) => <svg {...base(p)}><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor" /></svg>;
export const IconCopy = (p: P) => <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const IconBack = (p: P) => <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>;
export const IconUpload = (p: P) => <svg {...base(p)}><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>;
export const IconStar = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><path d="m12 2 3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21l1.5-7L2 9.3l7-.8z" /></svg>;
export const IconBack10 = (p: P) => <svg {...base(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">10</text></svg>;
export const IconFwd10 = (p: P) => <svg {...base(p)}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /><text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">10</text></svg>;
export const IconSparkle = (p: P) => <svg {...base(p)}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>;
export const IconLink = (p: P) => <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;
export const IconChevron = (p: P) => <svg {...base(p)}><path d="m9 18 6-6-6-6" /></svg>;

/** Filled glyphs for the tab bar (the selected and unselected states differ by colour, as on Apple TV). */
export const IconHomeFill = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none"><path d="M12.7 2.8a1.1 1.1 0 0 0-1.4 0L3.4 9.3A1.2 1.2 0 0 0 3 10.2V20a1.5 1.5 0 0 0 1.5 1.5H9a.5.5 0 0 0 .5-.5v-5a2.5 2.5 0 0 1 5 0v5a.5.5 0 0 0 .5.5h4.5A1.5 1.5 0 0 0 21 20v-9.8a1.2 1.2 0 0 0-.4-.9z" /></svg>;
export const IconGearFill = (p: P) => <svg {...base(p)} fill="currentColor" stroke="none" fillRule="evenodd"><path d="M10.3 2.2a1 1 0 0 1 1-.7h1.4a1 1 0 0 1 1 .7l.5 1.9a8 8 0 0 1 1.7 1l1.9-.6a1 1 0 0 1 1.1.4l.7 1.2a1 1 0 0 1-.1 1.2L18.1 8.7a8 8 0 0 1 0 2l1.4 1.4a1 1 0 0 1 .1 1.2l-.7 1.2a1 1 0 0 1-1.1.4l-1.9-.6a8 8 0 0 1-1.7 1l-.5 1.9a1 1 0 0 1-1 .7h-1.4a1 1 0 0 1-1-.7l-.5-1.9a8 8 0 0 1-1.7-1l-1.9.6a1 1 0 0 1-1.1-.4l-.7-1.2a1 1 0 0 1 .1-1.2l1.4-1.4a8 8 0 0 1 0-2L4.5 7.3a1 1 0 0 1-.1-1.2l.7-1.2a1 1 0 0 1 1.1-.4l1.9.6a8 8 0 0 1 1.7-1zM12 12.9a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" transform="translate(0 2.3)" /></svg>;
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
export const IconMic = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>;
