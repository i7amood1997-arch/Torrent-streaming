import { describe, expect, it, vi } from 'vitest';

describe('app store when browser storage is blocked', () => {
  it('still has a working persist API (the app used to crash on start)', async () => {
    const blocked = { get localStorage(): Storage { throw new DOMException('blocked', 'SecurityError'); } };
    vi.stubGlobal('window', blocked);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    vi.resetModules();
    const { useApp, safeStorage } = await import('../lib/store');
    expect(useApp.persist).toBeDefined();
    await useApp.persist.rehydrate();
    useApp.getState().updateSettings({ apiBase: 'http://x' });
    expect(useApp.getState().settings.apiBase).toBe('http://x');
    const s = safeStorage();
    s.setItem('a', 'b');
    expect(s.getItem('a')).toBe('b');
    vi.unstubAllGlobals();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
