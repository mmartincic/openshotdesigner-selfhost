#!/usr/bin/env node
/**
 * Open Shot Designer — self-hosted server.
 *
 * One process, no dependencies beyond Node itself:
 *   - serves the built app (dist/),
 *   - stores projects, images and workspace libraries under DATA_DIR,
 *     exposing them as a small key/value API the app talks to.
 *
 * Storage layout (plain files — easy to back up, snapshot or inspect):
 *   DATA_DIR/projects/<key>.json      {"rev": "...", "value": <project>}
 *   DATA_DIR/asset-meta/<key>.json    {"rev": "...", "value": <metadata>}
 *   DATA_DIR/meta/<key>.json          {"rev": "...", "value": <anything>}
 *   DATA_DIR/assets/<key>.bin         raw image bytes
 *   DATA_DIR/assets/<key>.json        {"rev": "...", "type": "<mime>"}
 *
 * Environment:
 *   PORT            listen port                       (default 8080)
 *   HOST            listen address                    (default 0.0.0.0)
 *   DATA_DIR        where data is written             (default ./data)
 *   STATIC_DIR      built app to serve                (default ../dist)
 *   MAX_BODY_MB     largest accepted upload, in MB    (default 256)
 *   AUTH_USER       \  optional built-in HTTP basic auth. Leave unset when a
 *   AUTH_PASSWORD   /  reverse proxy (Authentik, Authelia…) handles login.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(here, '..', 'dist'));
const MAX_BODY_BYTES = Math.max(1, Number(process.env.MAX_BODY_MB || 256)) * 1024 * 1024;
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const VERSION = process.env.APP_VERSION || 'dev';

const JSON_STORES = new Set(['projects', 'asset-meta', 'meta']);
const BINARY_STORES = new Set(['assets']);
const isStore = (name) => JSON_STORES.has(name) || BINARY_STORES.has(name);

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// Key <-> filename
// ---------------------------------------------------------------------------

/** Letters, digits, '_' and '-' stay as-is; every other byte becomes ~XX. */
const encodeKey = (key) =>
  Array.from(Buffer.from(key, 'utf8'))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9_-]/.test(ch) ? ch : `~${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');

const decodeKey = (name) => {
  const bytes = [];
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] === '~') {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(name.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 400;

// ---------------------------------------------------------------------------
// Index + atomic file IO
// ---------------------------------------------------------------------------

/** store -> Map<key, { rev, type? }> — authoritative in this single process. */
const index = new Map();

const newRev = () => `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
const storeDir = (store) => path.join(DATA_DIR, store);
const envelopePath = (store, key) => path.join(storeDir(store), `${encodeKey(key)}.json`);
const binaryPath = (key) => path.join(storeDir('assets'), `${encodeKey(key)}.bin`);

const atomicWrite = async (file, data) => {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
};

const loadIndex = async () => {
  for (const store of [...JSON_STORES, ...BINARY_STORES]) {
    const dir = storeDir(store);
    await mkdir(dir, { recursive: true });
    const entries = new Map();
    for (const name of await readdir(dir)) {
      if (name.includes('.tmp-')) {
        // Leftover from a write interrupted by a crash or power loss.
        await rm(path.join(dir, name), { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const envelope = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
        entries.set(decodeKey(name.slice(0, -5)), { rev: String(envelope.rev), type: envelope.type });
      } catch (error) {
        log(`WARN skipping unreadable ${store}/${name}: ${error.message}`);
      }
    }
    index.set(store, entries);
  }
};

/** Serialise every mutation of one key so precondition check + write is atomic. */
const locks = new Map();
const withLock = (id, work) => {
  const previous = locks.get(id) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(() => undefined, () => undefined);
  locks.set(id, settled);
  settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return result;
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

const sendJson = (res, status, body, extra = {}) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...API_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    ...extra,
  });
  res.end(data);
};

const sendError = (res, status, message) => sendJson(res, status, { error: message });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, `Upload larger than MAX_BODY_MB (${MAX_BODY_BYTES / 1048576} MB)`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `Upload larger than MAX_BODY_MB (${MAX_BODY_BYTES / 1048576} MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const parseEtag = (header) => (header ? String(header).replace(/^W\//, '').replace(/"/g, '').trim() : null);

/** HTTP preconditions: If-Match "<rev>" and If-None-Match: * */
const checkPreconditions = (req, current) => {
  const ifMatch = req.headers['if-match'];
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifMatch !== undefined) {
    const wanted = parseEtag(ifMatch);
    if (wanted !== '*' && (!current || current.rev !== wanted)) {
      throw new HttpError(412, 'Changed elsewhere (revision mismatch)');
    }
    if (wanted === '*' && !current) throw new HttpError(412, 'Does not exist');
  }
  if (ifNoneMatch !== undefined && String(ifNoneMatch).trim() === '*' && current) {
    throw new HttpError(412, 'Already exists');
  }
};

// ---------------------------------------------------------------------------
// Auth (optional)
// ---------------------------------------------------------------------------

const safeEqual = (a, b) => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

const authorized = (req) => {
  if (!AUTH_USER || !AUTH_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), AUTH_USER) && safeEqual(decoded.slice(sep + 1), AUTH_PASSWORD);
};

// ---------------------------------------------------------------------------
// KV API
// ---------------------------------------------------------------------------

const handleKv = async (req, res, store, key, query) => {
  if (!isStore(store)) throw new HttpError(404, 'Unknown store');
  const entries = index.get(store);

  // ---- collection ----
  if (key === null) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const list = [...entries.entries()].map(([k, meta]) => ({ key: k, rev: meta.rev }));
    if (query.get('values') === '1') {
      if (!JSON_STORES.has(store)) throw new HttpError(400, 'values=1 is only for JSON stores');
      const withValues = [];
      for (const item of list) {
        try {
          const envelope = JSON.parse(await readFile(envelopePath(store, item.key), 'utf8'));
          withValues.push({ key: item.key, rev: envelope.rev, value: envelope.value });
        } catch {
          // Deleted between listing and reading — skip it.
        }
      }
      sendJson(res, 200, withValues);
      return;
    }
    sendJson(res, 200, list);
    return;
  }

  if (!validKey(key)) throw new HttpError(400, 'Invalid key');
  const id = `${store}\u0000${key}`;

  // ---- read ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    const current = entries.get(key);
    if (!current) throw new HttpError(404, 'Not found');
    if (BINARY_STORES.has(store)) {
      const file = binaryPath(key);
      const info = await stat(file).catch(() => null);
      if (!info) throw new HttpError(404, 'Not found');
      res.writeHead(200, {
        ...API_HEADERS,
        'Content-Type': current.type || 'application/octet-stream',
        'X-Asset-Type': current.type || '',
        'Content-Length': info.size,
        ETag: `"${current.rev}"`,
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file).pipe(res);
      return;
    }
    const envelope = JSON.parse(await readFile(envelopePath(store, key), 'utf8'));
    const body = Buffer.from(JSON.stringify(envelope.value ?? null));
    res.writeHead(200, {
      ...API_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ETag: `"${envelope.rev}"`,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  // ---- write ----
  if (req.method === 'PUT') {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // Requiring a non-"simple" content type means a browser on another site
    // must pass a CORS preflight first — which this server never grants.
    if (BINARY_STORES.has(store) && contentType !== 'application/octet-stream') {
      throw new HttpError(415, 'Expected application/octet-stream');
    }
    if (JSON_STORES.has(store) && contentType !== 'application/json') {
      throw new HttpError(415, 'Expected application/json');
    }
    const body = await readBody(req);
    let value;
    if (JSON_STORES.has(store)) {
      try {
        value = JSON.parse(body.toString('utf8') || 'null');
      } catch {
        throw new HttpError(400, 'Body is not valid JSON');
      }
    }
    const rev = await withLock(id, async () => {
      checkPreconditions(req, entries.get(key));
      const next = newRev();
      if (BINARY_STORES.has(store)) {
        const type = String(req.headers['x-asset-type'] ?? '').slice(0, 200);
        await atomicWrite(binaryPath(key), body);
        await atomicWrite(envelopePath(store, key), JSON.stringify({ rev: next, type }));
        entries.set(key, { rev: next, type });
      } else {
        await atomicWrite(envelopePath(store, key), JSON.stringify({ rev: next, value }));
        entries.set(key, { rev: next });
      }
      return next;
    });
    sendJson(res, 200, { rev }, { ETag: `"${rev}"` });
    return;
  }

  // ---- delete ----
  if (req.method === 'DELETE') {
    await withLock(id, async () => {
      const current = entries.get(key);
      checkPreconditions(req, current);
      if (!current) throw new HttpError(404, 'Not found');
      await rm(envelopePath(store, key), { force: true });
      if (BINARY_STORES.has(store)) await rm(binaryPath(key), { force: true });
      entries.delete(key);
    });
    res.writeHead(204, API_HEADERS);
    res.end();
    return;
  }

  throw new HttpError(405, 'Method not allowed');
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const serveFile = async (req, res, file, cacheControl) => {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
};

const handleStatic = async (req, res, pathname) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  const file = path.resolve(STATIC_DIR, `.${decoded}`);
  if (file !== STATIC_DIR && !file.startsWith(`${STATIC_DIR}${path.sep}`)) throw new HttpError(403, 'Forbidden');

  // Hashed build output never changes; the shell and the service worker must
  // always be revalidated so a new deploy is picked up.
  const immutable = decoded.startsWith('/assets/');
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (decoded !== '/' && (await serveFile(req, res, file, cache))) return;

  // SPA fallback for client-side routes (anything without a file extension).
  if (decoded === '/' || !path.extname(decoded)) {
    if (await serveFile(req, res, path.join(STATIC_DIR, 'index.html'), 'no-cache')) return;
  }
  throw new HttpError(404, 'Not found');
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const { pathname } = url;
  try {
    // Unauthenticated liveness probe for Docker / TrueNAS health checks.
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Open Shot Designer", charset="UTF-8"',
        'Content-Type': 'text/plain',
      });
      res.end('Sign-in required');
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: VERSION });
      return;
    }

    const kv = pathname.match(/^\/api\/kv\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (kv) {
      let store;
      let key = null;
      try {
        store = decodeURIComponent(kv[1]);
        if (kv[2] !== undefined) key = decodeURIComponent(kv[2]);
      } catch {
        throw new HttpError(400, 'Bad path');
      }
      await handleKv(req, res, store, key, url.searchParams);
      return;
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API route');

    await handleStatic(req, res, pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) log(`ERROR ${req.method} ${pathname}:`, error);
    if (!res.headersSent) sendError(res, status, error.message || 'Server error');
    else res.destroy();
  }
});

server.requestTimeout = 10 * 60 * 1000;

await mkdir(DATA_DIR, { recursive: true });
await loadIndex();

server.listen(PORT, HOST, () => {
  const counts = [...index.entries()].map(([store, entries]) => `${store}=${entries.size}`).join(' ');
  log(`Open Shot Designer ${VERSION} on http://${HOST}:${PORT}`);
  log(`data: ${DATA_DIR} (${counts})`);
  log(`app:  ${STATIC_DIR}`);
  log(AUTH_USER && AUTH_PASSWORD ? 'auth: built-in basic auth enabled' : 'auth: none (put it behind your proxy\'s login)');
});

const shutdown = (signal) => {
  log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
