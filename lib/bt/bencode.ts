/** Minimal bencode codec over Uint8Array (BitTorrent metadata, tracker and extension messages). */
export type BVal = number | Uint8Array | BVal[] | { [key: string]: BVal };

const te = new TextEncoder();
const td = new TextDecoder();

const ascii = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** Decode one value starting at `start`. Byte strings are returned as views into `buf`. */
export function bdecode(buf: Uint8Array, start = 0): { value: BVal; end: number } {
  let i = start;
  let depth = 0;
  const fail = (m: string): never => { throw new Error(`bencode: ${m} at ${i}`); };

  const parse = (): BVal => {
    if (i >= buf.length) fail('unexpected end');
    if (++depth > 64) fail('too deep');
    const c = buf[i];
    let out: BVal;
    if (c === 0x69) { // i<int>e
      const e = buf.indexOf(0x65, i);
      if (e < 0) fail('unterminated int');
      out = Number(ascii(buf.subarray(i + 1, e)));
      if (!Number.isFinite(out)) fail('bad int');
      i = e + 1;
    } else if (c === 0x6c) { // l...e
      i++;
      const list: BVal[] = [];
      while (buf[i] !== 0x65) { if (i >= buf.length) fail('unterminated list'); list.push(parse()); }
      i++;
      out = list;
    } else if (c === 0x64) { // d...e
      i++;
      const dict: { [key: string]: BVal } = {};
      while (buf[i] !== 0x65) {
        if (i >= buf.length) fail('unterminated dict');
        const k = parse();
        if (!(k instanceof Uint8Array)) fail('dict key is not a string');
        dict[ascii(k as Uint8Array)] = parse();
      }
      i++;
      out = dict;
    } else if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, i);
      if (colon < 0 || colon - i > 12) fail('bad string length');
      const len = Number(ascii(buf.subarray(i, colon)));
      const s = colon + 1;
      if (!Number.isInteger(len) || s + len > buf.length) fail('string out of range');
      i = s + len;
      out = buf.subarray(s, i);
    } else {
      out = fail('unexpected byte');
    }
    depth--;
    return out;
  };

  const value = parse();
  return { value, end: i };
}

/** Encodable input: like BVal, but text strings are allowed (encoded as UTF-8). */
export type BIn = number | string | Uint8Array | BIn[] | { [key: string]: BIn };

export function bencode(v: BIn): Uint8Array {
  const parts: Uint8Array[] = [];
  const put = (x: BIn) => {
    if (typeof x === 'number') parts.push(te.encode(`i${Math.trunc(x)}e`));
    else if (typeof x === 'string') { const b = te.encode(x); parts.push(te.encode(`${b.length}:`), b); }
    else if (x instanceof Uint8Array) parts.push(te.encode(`${x.length}:`), x);
    else if (Array.isArray(x)) { parts.push(te.encode('l')); x.forEach(put); parts.push(te.encode('e')); }
    else {
      parts.push(te.encode('d'));
      for (const k of Object.keys(x).sort()) { put(k); put(x[k]); }
      parts.push(te.encode('e'));
    }
  };
  put(v);
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const bstr = (v: BVal | undefined): string | undefined => (v instanceof Uint8Array ? td.decode(v) : undefined);
export const bnum = (v: BVal | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
export const bdict = (v: BVal | undefined): { [key: string]: BVal } | undefined =>
  v && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v) ? v : undefined;

// ─── Torrent metadata ("info" dictionary) ───────────────────────────────────

export interface TorrentFile {
  index: number;
  path: string;
  name: string;
  length: number;
  /** Byte offset of the file inside the torrent's concatenated data. */
  offset: number;
}

export interface TorrentInfo {
  name: string;
  pieceLength: number;
  numPieces: number;
  /** Concatenated 20-byte SHA-1 piece hashes. */
  pieces: Uint8Array;
  length: number;
  files: TorrentFile[];
}

export function parseInfo(raw: Uint8Array): TorrentInfo {
  const info = bdict(bdecode(raw).value);
  if (!info) throw new Error('info is not a dictionary');
  const name = bstr(info['name.utf-8']) ?? bstr(info.name) ?? 'torrent';
  const pieceLength = bnum(info['piece length']);
  const pieces = info.pieces;
  if (!pieceLength || !(pieces instanceof Uint8Array) || pieces.length % 20) throw new Error('invalid info dictionary (v1 pieces required)');

  const files: TorrentFile[] = [];
  let offset = 0;
  if (Array.isArray(info.files)) {
    info.files.forEach((f, index) => {
      const d = bdict(f);
      const len = bnum(d?.length) ?? 0;
      const parts = (d?.['path.utf-8'] ?? d?.path) as BVal[] | undefined;
      const path = Array.isArray(parts) ? parts.map((p) => bstr(p) ?? '').join('/') : `file-${index}`;
      files.push({ index, path, name: path.split('/').pop() || path, length: len, offset });
      offset += len;
    });
  } else {
    const len = bnum(info.length) ?? 0;
    files.push({ index: 0, path: name, name, length: len, offset: 0 });
    offset = len;
  }
  // Copy the hashes so the (possibly large) raw buffer isn't pinned by a view.
  return { name, pieceLength, numPieces: pieces.length / 20, pieces: pieces.slice(), length: offset, files };
}
