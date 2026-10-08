/**
 * Where project data lives.
 *
 * - `browser` (default): IndexedDB in this browser, exactly as upstream.
 * - `server`: a self-hosted Open Shot Designer server (see `server/` and
 *   SELF-HOSTING.md). Every device that opens the same URL sees the same
 *   projects, images and workspace libraries.
 *
 * Chosen at build time (`npm run build:server`, or `VITE_STORAGE=server`) so a self-hosted build can
 * never silently fall back to per-browser storage and split your data.
 */

const BUILD_MODE: 'browser' | 'server' =
  import.meta.env.VITE_STORAGE === 'server' || import.meta.env.MODE === 'selfhost' ? 'server' : 'browser';

let override: boolean | null = null;

export const isServerStorage = (): boolean => override ?? BUILD_MODE === 'server';

/** Test hook: force server mode on or off (null restores the build setting). */
export const setServerStorageForTests = (value: boolean | null): void => {
  override = value;
};

/** Base URL of the storage API, relative to wherever the app is served. */
export const apiBase = (): string => `${import.meta.env.BASE_URL ?? '/'}api`;
