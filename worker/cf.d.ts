/** Minimal ambient types for the Cloudflare runtime modules used by the Worker. */
declare module 'cloudflare:sockets' {
  export function connect(
    address: { hostname: string; port: number } | string,
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean },
  ): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<unknown>;
    closed: Promise<void>;
    close(): Promise<void>;
  };
}

declare module 'cloudflare:workers' {
  export class DurableObject<E = unknown> {
    constructor(ctx: DurableObjectState, env: E);
    protected ctx: DurableObjectState;
    protected env: E;
  }
  export interface DurableObjectState {
    storage: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    };
  }
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
