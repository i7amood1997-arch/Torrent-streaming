'use client';
/**
 * Last line of defence: if a screen throws while rendering, show a way out instead of a
 * frozen, blank app. Settings and history live in storage, so a reload loses nothing.
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Streamdeck crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 grid place-items-center bg-black p-6 text-center">
        <div className="max-w-sm space-y-4">
          <h1 className="text-2xl font-bold text-white">Something went wrong</h1>
          <p className="text-sm text-ink-400">The app hit an unexpected problem. Your settings and history are safe.</p>
          <div className="flex justify-center gap-2">
            <button className="btn-primary rounded-full px-6" onClick={() => location.reload()} autoFocus>Reload</button>
            <button className="btn-glass rounded-full px-5" onClick={() => this.setState({ error: undefined })}>Try again</button>
          </div>
          <p className="break-all text-[11px] text-ink-600">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
