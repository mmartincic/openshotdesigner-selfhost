/**
 * Workspace libraries that upstream keeps in localStorage but that are really
 * user content: saved assemblies and hand-authored fixture profiles. In a
 * self-hosted build they are mirrored to the server's `meta` store so every
 * device gets the same libraries.
 *
 * The app keeps reading them synchronously from localStorage, unchanged:
 * - at startup (and when the tab regains focus) the server copy is pulled into
 *   localStorage; the server wins,
 * - after each local save, `pushSyncedLocalKey` sends the new value up.
 *
 * In the default browser-only build every function here is a no-op.
 */

import { isServerStorage } from '../../config/storage';
import { hasPendingRemoteWrites, remoteGet, remotePut } from './remote';

export const SYNCED_LOCAL_KEYS = ['assemblies_v1', 'custom_fixture_profiles_v1'] as const;
export type SyncedLocalKey = (typeof SYNCED_LOCAL_KEYS)[number];

const META_STORE = 'meta';
const remoteKey = (key: string) => `local:${key}`;

const listeners = new Map<string, Set<() => void>>();

/** Run `listener` whenever a pull from the server changed `key`. */
export const onSyncedKeyChanged = (key: SyncedLocalKey, listener: () => void): (() => void) => {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => set.delete(listener);
};

const readLocal = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Send the current local value of `key` to the server (fire-and-forget). */
export const pushSyncedLocalKey = (key: SyncedLocalKey): void => {
  if (!isServerStorage()) return;
  const raw = readLocal(key);
  void remotePut(META_STORE, remoteKey(key), raw).catch(() => {
    // Best effort, like upstream's localStorage write; the next save retries.
  });
};

const pullKey = async (key: SyncedLocalKey): Promise<void> => {
  if (hasPendingRemoteWrites(META_STORE)) return;
  const remote = await remoteGet<string | null>(META_STORE, remoteKey(key));
  const local = readLocal(key);
  if (remote === undefined) {
    // Nothing on the server yet: seed it from this device, if it has data.
    if (local !== null) pushSyncedLocalKey(key);
    return;
  }
  if (remote === local) return;
  try {
    if (remote === null) localStorage.removeItem(key);
    else localStorage.setItem(key, remote);
  } catch {
    return;
  }
  listeners.get(key)?.forEach((listener) => listener());
};

let installed = false;

/** Pull every synced key from the server. Never throws. */
export const hydrateSyncedLocalKeys = async (): Promise<void> => {
  if (!isServerStorage()) return;
  await Promise.all(SYNCED_LOCAL_KEYS.map((key) => pullKey(key).catch(() => undefined)));
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const refresh = () => {
    if (document.visibilityState !== 'visible') return;
    SYNCED_LOCAL_KEYS.forEach((key) => void pullKey(key).catch(() => undefined));
  };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
};
