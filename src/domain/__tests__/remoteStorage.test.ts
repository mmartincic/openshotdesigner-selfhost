import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServerStorageForTests } from '../../config/storage';
import { idbGet, idbPut, idbGetAllValues } from '../storage/idb';
import {
  getKnownRevision,
  getLastRemoteErrorKind,
  isRemoteConflict,
  registerContentFingerprint,
  remoteGet,
  remotePut,
} from '../storage/remote';
import { pushSyncedLocalKey, hydrateSyncedLocalKeys } from '../storage/syncedLocalKeys';

/**
 * A tiny in-memory stand-in for server/server.mjs: same routes, same
 * revision/precondition rules, with an optional per-request delay so tests
 * can make requests overtake each other.
 */
const createFakeServer = () => {
  const stores = new Map<string, Map<string, { rev: string; body: unknown; type?: string }>>();
  let revCounter = 0;
  const log: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  let delayFor: (method: string, body: unknown) => number = () => 0;

  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'http://x');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: unknown;
    if (init.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else if (typeof init.body === 'string') body = JSON.parse(init.body);
    log.push({ method, url: url.pathname + url.search, headers, body });
    const delay = delayFor(method, body);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    if (url.pathname === '/api/health') return Response.json({ ok: true });
    const match = url.pathname.match(/^\/api\/kv\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return new Response('no', { status: 404 });
    const entries = store(decodeURIComponent(match[1]));
    const key = match[2] !== undefined ? decodeURIComponent(match[2]) : null;

    if (key === null) {
      const list = [...entries].map(([k, v]) => ({ key: k, rev: v.rev, ...(url.search ? { value: v.body } : {}) }));
      return Response.json(list);
    }
    const current = entries.get(key);
    if (method === 'GET') {
      if (!current) return new Response('', { status: 404 });
      if (current.body instanceof Uint8Array) {
        const bytes = current.body;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return new Response(buffer, { headers: { ETag: `"${current.rev}"`, 'X-Asset-Type': current.type ?? '' } });
      }
      return Response.json(current.body, { headers: { ETag: `"${current.rev}"` } });
    }
    if (method === 'PUT') {
      const ifMatch = headers['if-match']?.replace(/"/g, '');
      if (ifMatch && current?.rev !== ifMatch) return new Response('', { status: 412 });
      if (headers['if-none-match'] === '*' && current) return new Response('', { status: 412 });
      const rev = `r${++revCounter}`;
      entries.set(key, { rev, body, type: headers['x-asset-type'] });
      return Response.json({ rev });
    }
    if (method === 'DELETE') {
      entries.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };

  return {
    fetchImpl,
    log,
    store,
    setDelay: (fn: typeof delayFor) => {
      delayFor = fn;
    },
    /** Simulate another device saving. */
    externalWrite: (storeName: string, key: string, body: unknown) => {
      store(storeName).set(key, { rev: `ext${++revCounter}`, body });
    },
  };
};

let server: ReturnType<typeof createFakeServer>;

beforeEach(() => {
  server = createFakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetchImpl));
  setServerStorageForTests(true);
});

afterEach(() => {
  setServerStorageForTests(null);
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('server storage backend', () => {
  it('routes idb helpers to the server and round-trips JSON', async () => {
    await idbPut('meta', 'k-roundtrip', { hello: 'world' });
    expect(await idbGet('meta', 'k-roundtrip')).toEqual({ hello: 'world' });
    expect(await idbGet('meta', 'missing-key')).toBeUndefined();
  });

  it('stores asset records as raw bytes and restores the same record shape', async () => {
    const data = new Uint8Array([1, 2, 3, 250]);
    await idbPut('assets', 'asset-sha256-x', { __assetBlob: true, type: 'image/jpeg', data });
    const put = server.log.find((entry) => entry.method === 'PUT')!;
    expect(put.headers['content-type']).toBe('application/octet-stream');
    expect(put.headers['x-asset-type']).toBe('image/jpeg');
    const back = await idbGet<{ __assetBlob: true; type: string; data: Uint8Array }>('assets', 'asset-sha256-x');
    expect(back?.type).toBe('image/jpeg');
    expect([...back!.data]).toEqual([1, 2, 3, 250]);
  });

  it('keeps writes to one key in order even when an earlier request is slower', async () => {
    // First PUT takes 50 ms, later ones are instant: without the queue the
    // older value would land last and win.
    server.setDelay((method, body) => (method === 'PUT' && (body as { v: number }).v === 1 ? 50 : 0));
    const first = remotePut('meta', 'ordered', { v: 1 });
    const second = remotePut('meta', 'ordered', { v: 2 });
    await Promise.all([first, second]);
    expect(server.store('meta').get('ordered')?.body).toEqual({ v: 2 });
  });

  it('skips queued writes that a newer write has superseded', async () => {
    // Started one at a time, with a newer save arriving while one is in flight.
    server.setDelay((method) => (method === 'PUT' ? 30 : 0));
    const inFlight = remotePut('meta', 'coalesce-staggered', { v: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = [2, 3, 4].map((v) => remotePut('meta', 'coalesce-staggered', { v }));
    await Promise.all([inFlight, ...queued]);
    const staggered = server.log.filter((entry) => entry.method === 'PUT' && entry.url.endsWith('/coalesce-staggered'));
    expect(staggered.map((entry) => (entry.body as { v: number }).v)).toEqual([1, 4]);

    server.setDelay((method) => (method === 'PUT' ? 20 : 0));
    await Promise.all([1, 2, 3, 4, 5].map((v) => remotePut('meta', 'coalesce', { v })));
    const puts = server.log.filter((entry) => entry.method === 'PUT' && entry.url.endsWith('/coalesce'));
    // All five were queued in the same tick, so only the newest is sent.
    expect(puts.map((entry) => (entry.body as { v: number }).v)).toEqual([5]);
    expect(server.store('meta').get('coalesce')?.body).toEqual({ v: 5 });
  });

  it('creates new projects with If-None-Match and updates with If-Match', async () => {
    await remotePut('projects', 'p-new', { id: 'p-new', title: 'A' });
    await remotePut('projects', 'p-new', { id: 'p-new', title: 'B' });
    const puts = server.log.filter((entry) => entry.method === 'PUT');
    expect(puts[0].headers['if-none-match']).toBe('*');
    expect(puts[1].headers['if-match']).toBe('"r1"');
    expect(getKnownRevision('projects', 'p-new')).toBe('r2');
  });

  it('refuses to overwrite a project another device changed, and reports a conflict', async () => {
    await remotePut('projects', 'p-conflict', { id: 'p-conflict', title: 'mine' });
    server.externalWrite('projects', 'p-conflict', { id: 'p-conflict', title: 'theirs' });
    const error = await remotePut('projects', 'p-conflict', { id: 'p-conflict', title: 'mine again' }).catch((e) => e);
    expect(isRemoteConflict(error)).toBe(true);
    expect(getLastRemoteErrorKind()).toBe('conflict');
    expect(server.store('projects').get('p-conflict')?.body).toEqual({ id: 'p-conflict', title: 'theirs' });
  });

  it('does not send a save when only view-only fields changed', async () => {
    registerContentFingerprint('projects', (value) => {
      const { zoom: _zoom, ...rest } = value as Record<string, unknown>;
      return JSON.stringify(rest);
    });
    await idbGetAllValues('projects'); // nothing yet
    await remotePut('projects', 'p-view', { id: 'p-view', title: 'T', zoom: 1 });
    await remotePut('projects', 'p-view', { id: 'p-view', title: 'T', zoom: 0.4 });
    await remotePut('projects', 'p-view', { id: 'p-view', title: 'T2', zoom: 0.4 });
    const puts = server.log.filter((entry) => entry.method === 'PUT' && entry.url.endsWith('/p-view'));
    expect(puts.map((entry) => (entry.body as { title: string }).title)).toEqual(['T', 'T2']);
  });

  it('reports an expired forward-auth session as an auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: new Headers() }) as Response),
    );
    const error: unknown = await remoteGet('meta', 'anything').catch((e: unknown) => e);
    expect((error as { kind?: string }).kind).toBe('auth');
  });
});

describe('synced workspace libraries', () => {
  it('pulls the server copy into localStorage and pushes local saves up', async () => {
    server.store('meta').set('local:assemblies_v1', { rev: 'r0', body: '[{"id":"a1"}]' });
    await hydrateSyncedLocalKeys();
    expect(localStorage.getItem('assemblies_v1')).toBe('[{"id":"a1"}]');

    localStorage.setItem('custom_fixture_profiles_v1', '[{"id":"manual:x/y","model":"Y"}]');
    pushSyncedLocalKey('custom_fixture_profiles_v1');
    await vi.waitFor(() =>
      expect(server.store('meta').get('local:custom_fixture_profiles_v1')?.body).toBe(
        '[{"id":"manual:x/y","model":"Y"}]',
      ),
    );
  });

  it('is a no-op in the default browser-only build', async () => {
    setServerStorageForTests(false);
    localStorage.setItem('assemblies_v1', '[]');
    pushSyncedLocalKey('assemblies_v1');
    await hydrateSyncedLocalKeys();
    expect(server.log).toHaveLength(0);
  });
});
