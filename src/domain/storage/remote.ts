/**
 * Server-backed key/value storage — the self-hosted replacement for the
 * IndexedDB helpers in `idb.ts`.
 *
 * The server (see `server/server.mjs`) exposes the same four stores the
 * browser database has (`projects`, `assets`, `asset-meta`, `meta`) as:
 *
 *   GET    /api/kv/:store            → [{ key, rev }]
 *   GET    /api/kv/:store?values=1   → [{ key, rev, value }]   (JSON stores)
 *   GET    /api/kv/:store/:key       → value (JSON, or raw bytes for assets)
 *   PUT    /api/kv/:store/:key       → { rev }
 *   DELETE /api/kv/:store/:key       → 204
 *
 * Three things matter beyond plain HTTP:
 *
 * 1. Ordering. Autosave fires every few hundred milliseconds. Two PUTs of the
 *    same key racing over a slow link could land out of order and leave the
 *    older version on the server. Every mutation of a key is queued behind the
 *    previous one, and a queued write that has already been superseded by a
 *    newer one is skipped — the newer one carries all of its data.
 *
 * 2. Cross-device conflicts. Projects carry a server revision. A save sends
 *    the revision it was based on (`If-Match`); if another device saved in the
 *    meantime the server answers 412 and nothing is overwritten. The caller
 *    surfaces that as "changed elsewhere — reload".
 *
 * 3. View-only changes. Upstream keeps some per-screen view state inside the
 *    project (zoom, pan, open scene, timeline playhead). Merely opening a
 *    project on a phone re-fits the zoom and would count as an edit, flagging
 *    the laptop's copy as stale. A store can register a "content fingerprint"
 *    that leaves such fields out; a save whose fingerprint matches what the
 *    server already holds is not sent at all.
 *
 * 4. Sign-in expiry. Behind a forward-auth proxy (Authentik, Authelia…) an
 *    expired session turns API calls into redirects to a login page. Requests
 *    use `redirect: 'manual'` so that shows up as an auth error instead of a
 *    confusing parse failure.
 */

import { apiBase } from '../../config/storage';

export const REMOTE_BINARY_STORES = new Set(['assets']);
/** Stores whose writes are guarded by revisions (cross-device conflicts). */
const REVISIONED_STORES = new Set(['projects']);

export type RemoteErrorKind = 'conflict' | 'auth' | 'network' | 'server';

export class RemoteStorageError extends Error {
  constructor(
    public readonly kind: RemoteErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteStorageError';
  }
}

export const isRemoteConflict = (error: unknown): boolean =>
  error instanceof RemoteStorageError && error.kind === 'conflict';

// ---------------------------------------------------------------------------
// Last-error tracking (for the autosave banner)
// ---------------------------------------------------------------------------

let lastErrorKind: RemoteErrorKind | null = null;

/** The kind of the most recent failed request, cleared by the next success. */
export const getLastRemoteErrorKind = (): RemoteErrorKind | null => lastErrorKind;

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

const revisions = new Map<string, string>();
const revId = (store: string, key: string) => `${store}\u0000${key}`;

export const getKnownRevision = (store: string, key: string): string | undefined =>
  revisions.get(revId(store, key));

export const setKnownRevision = (store: string, key: string, rev: string | undefined): void => {
  if (rev) revisions.set(revId(store, key), rev);
  else revisions.delete(revId(store, key));
};

// ---------------------------------------------------------------------------
// Content fingerprints (skip view-only saves)
// ---------------------------------------------------------------------------

const fingerprinters = new Map<string, (value: unknown) => string>();
const serverFingerprints = new Map<string, string>();

/**
 * Register how to fingerprint the meaningful content of values in `store`.
 * Saves whose fingerprint equals the one last seen on the server are skipped.
 */
export const registerContentFingerprint = (store: string, fingerprint: (value: unknown) => string): void => {
  fingerprinters.set(store, fingerprint);
};

const fingerprintOf = (store: string, value: unknown): string | undefined => {
  const fn = fingerprinters.get(store);
  if (!fn) return undefined;
  try {
    return fn(value);
  } catch {
    return undefined;
  }
};

const rememberServerValue = (store: string, key: string, value: unknown): void => {
  const fp = fingerprintOf(store, value);
  if (fp === undefined) serverFingerprints.delete(revId(store, key));
  else serverFingerprints.set(revId(store, key), fp);
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [400, 1500, 4000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const storeUrl = (store: string) => `${apiBase()}/kv/${encodeURIComponent(store)}`;
const keyUrl = (store: string, key: string) => `${storeUrl(store)}/${encodeURIComponent(key)}`;

const classify = async (response: Response): Promise<RemoteStorageError> => {
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
    return new RemoteStorageError(
      'auth',
      'The storage server needs you to sign in again. Reload the page to sign in.',
      response.status || undefined,
    );
  }
  if (response.status === 412 || response.status === 409) {
    return new RemoteStorageError(
      'conflict',
      'This project was changed on another device or in another browser tab.',
      response.status,
    );
  }
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // ignore
  }
  return new RemoteStorageError(
    'server',
    `Storage server error ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
  );
};

/**
 * fetch with retries for transient failures (network errors, 5xx, 429).
 * Never retries auth or conflict answers — those need the user.
 */
const request = async (url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> => {
  let attempt = 0;
  for (;;) {
    let response: Response | null = null;
    let networkError: unknown = null;
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        ...init,
      });
    } catch (error) {
      networkError = error;
    }

    if (response && (response.ok || okStatuses.includes(response.status))) {
      lastErrorKind = null;
      return response;
    }

    const transient =
      networkError !== null || (response !== null && (response.status >= 500 || response.status === 429));
    if (transient && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
      continue;
    }

    const error = response
      ? await classify(response)
      : new RemoteStorageError('network', 'Cannot reach the storage server (offline?).');
    lastErrorKind = error.kind;
    throw error;
  }
};

const readRev = (response: Response): string | undefined => {
  const etag = response.headers.get('ETag');
  return etag ? etag.replace(/^W\//, '').replace(/"/g, '') : undefined;
};

// ---------------------------------------------------------------------------
// Per-key write queue
// ---------------------------------------------------------------------------

const chains = new Map<string, Promise<void>>();
const latestTicket = new Map<string, number>();
let ticketCounter = 0;

/**
 * Run `op` after every earlier mutation of the same key. If a later mutation
 * was queued before this one started, this one is skipped (resolves without
 * sending) because the later one supersedes it.
 */
const enqueueMutation = (id: string, op: () => Promise<void>): Promise<void> => {
  const ticket = ++ticketCounter;
  latestTicket.set(id, ticket);
  const previous = chains.get(id) ?? Promise.resolve();
  const run = () => (latestTicket.get(id) === ticket ? op() : Promise.resolve());
  const result = previous.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, settled);
  void settled.then(() => {
    if (chains.get(id) === settled) {
      chains.delete(id);
      if (latestTicket.get(id) === ticket) latestTicket.delete(id);
    }
  });
  return result;
};

/** True while any write to the given store is queued or in flight. */
export const hasPendingRemoteWrites = (store?: string): boolean => {
  if (!store) return chains.size > 0;
  const prefix = `${store}\u0000`;
  for (const id of chains.keys()) if (id.startsWith(prefix)) return true;
  return false;
};

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

interface AssetBlobRecord {
  __assetBlob: true;
  type: string;
  data: Uint8Array<ArrayBuffer>;
}

const toBinaryBody = (value: unknown): { body: Uint8Array<ArrayBuffer>; type: string } => {
  const record = value as Partial<AssetBlobRecord> | null;
  if (record && record.__assetBlob && record.data) {
    return { body: record.data, type: record.type ?? '' };
  }
  if (value instanceof ArrayBuffer) return { body: new Uint8Array(value), type: '' };
  if (ArrayBuffer.isView(value)) {
    return {
      body: new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength),
      type: '',
    };
  }
  throw new RemoteStorageError('server', 'Binary store received a non-binary value.');
};

// ---------------------------------------------------------------------------
// Public API (mirrors idb.ts)
// ---------------------------------------------------------------------------

/** Cheap reachability + auth check, used once at startup. */
export const remotePing = async (): Promise<void> => {
  const response = await request(`${apiBase()}/health`);
  const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
  if (!body?.ok) throw new RemoteStorageError('server', 'Storage server did not answer the health check.');
};

export const remoteGet = async <T>(store: string, key: string): Promise<T | undefined> => {
  const response = await request(keyUrl(store, key), {}, [404]);
  if (response.status === 404) {
    setKnownRevision(store, key, undefined);
    serverFingerprints.delete(revId(store, key));
    return undefined;
  }
  setKnownRevision(store, key, readRev(response));
  if (REMOTE_BINARY_STORES.has(store)) {
    const type = response.headers.get('X-Asset-Type') ?? response.headers.get('Content-Type') ?? '';
    const data = new Uint8Array(await response.arrayBuffer());
    return { __assetBlob: true, type, data } as unknown as T;
  }
  const value = (await response.json()) as T;
  rememberServerValue(store, key, value);
  return value;
};

interface ListedEntry<T> {
  key: string;
  rev: string;
  value?: T;
}

export const remoteListRevisions = async (store: string): Promise<{ key: string; rev: string }[]> => {
  const response = await request(storeUrl(store));
  return (await response.json()) as { key: string; rev: string }[];
};

export const remoteGetAllKeys = async (store: string): Promise<string[]> =>
  (await remoteListRevisions(store)).map((entry) => entry.key);

export const remoteGetAllValues = async <T>(store: string): Promise<T[]> => {
  if (REMOTE_BINARY_STORES.has(store)) {
    const keys = await remoteGetAllKeys(store);
    const values = await Promise.all(keys.map((key) => remoteGet<T>(store, key)));
    return values.filter((value): value is Awaited<T> => value !== undefined) as T[];
  }
  const response = await request(`${storeUrl(store)}?values=1`);
  const entries = (await response.json()) as ListedEntry<T>[];
  entries.forEach((entry) => {
    setKnownRevision(store, entry.key, entry.rev);
    rememberServerValue(store, entry.key, entry.value);
  });
  return entries.map((entry) => entry.value as T);
};

export const remotePut = (store: string, key: string, value: unknown): Promise<void> =>
  enqueueMutation(revId(store, key), async () => {
    const id = revId(store, key);
    const fingerprint = fingerprintOf(store, value);
    if (
      fingerprint !== undefined &&
      revisions.has(id) &&
      serverFingerprints.get(id) === fingerprint
    ) {
      // Only view state changed — the server copy is already current.
      lastErrorKind = null;
      return;
    }
    const headers: Record<string, string> = {};
    let body: BodyInit;
    if (REMOTE_BINARY_STORES.has(store)) {
      const binary = toBinaryBody(value);
      body = new Blob([binary.body], { type: 'application/octet-stream' });
      headers['Content-Type'] = 'application/octet-stream';
      headers['X-Asset-Type'] = binary.type;
    } else {
      body = JSON.stringify(value ?? null);
      headers['Content-Type'] = 'application/json';
    }
    if (REVISIONED_STORES.has(store)) {
      const known = getKnownRevision(store, key);
      if (known) headers['If-Match'] = `"${known}"`;
      else headers['If-None-Match'] = '*';
    }
    const response = await request(keyUrl(store, key), { method: 'PUT', headers, body });
    const result = (await response.json().catch(() => null)) as { rev?: string } | null;
    setKnownRevision(store, key, result?.rev ?? readRev(response));
    if (fingerprint === undefined) serverFingerprints.delete(id);
    else serverFingerprints.set(id, fingerprint);
  });

export const remoteDelete = (store: string, key: string): Promise<void> =>
  enqueueMutation(revId(store, key), async () => {
    const headers: Record<string, string> = {};
    if (REVISIONED_STORES.has(store)) {
      const known = getKnownRevision(store, key);
      if (known) headers['If-Match'] = `"${known}"`;
    }
    await request(keyUrl(store, key), { method: 'DELETE', headers }, [404]);
    setKnownRevision(store, key, undefined);
    serverFingerprints.delete(revId(store, key));
  });
