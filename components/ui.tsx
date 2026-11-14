'use client';
/** Small shared UI pieces: switch, segmented control, grouped list sections and rows. */
import { useState } from 'react';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition disabled:opacity-40 ${checked ? 'bg-on' : 'bg-ink-600'}`}
    >
      <span className={`inline-block h-[27px] w-[27px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-ink-800 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded-md font-medium transition ${size === 'sm' ? 'min-h-[30px] px-3 py-1 text-xs' : 'min-h-[34px] px-3.5 py-1.5 text-sm'} ${value === o.value ? 'bg-ink-600 text-white shadow' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A titled group of rows, iOS-settings style. */
export function Section({ title, footer, children, className = '' }: { title?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      {title && <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{title}</h3>}
      <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">{children}</div>
      {footer && <p className="mt-2 px-1 text-xs leading-relaxed text-ink-400">{footer}</p>}
    </section>
  );
}

export function Row({ label, hint, children, onClick, htmlFor, wrap }: { label: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; onClick?: () => void; htmlFor?: string; /** Let the control drop below the label on narrow screens. */ wrap?: boolean }) {
  const body = (
    <>
      <span className={wrap ? 'min-w-[5rem] flex-1' : 'min-w-0 flex-1'}>
        <span className="block text-sm text-ink-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-ink-400">{hint}</span>}
      </span>
      {children}
    </>
  );
  if (onClick) return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink-800/60">{body}</button>;
  if (htmlFor) return <label htmlFor={htmlFor} className="flex items-center gap-3 px-4 py-3">{body}</label>;
  return <div className={`flex items-center gap-3 px-4 py-3 ${wrap ? 'flex-wrap gap-y-2' : ''}`}>{body}</div>;
}

/** Collapsible group (closed by default). */
export function Disclosure({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between px-1 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400 hover:text-ink-200">
        {title}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}
