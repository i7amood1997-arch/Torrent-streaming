import { NextResponse } from 'next/server';

export function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export function intParam(v: string | null): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Per-user key from request header, falling back to the server environment. */
export function keyFrom(req: Request, header: string, envValue?: string): string | undefined {
  const v = req.headers.get(header)?.trim();
  return v || envValue || undefined;
}
