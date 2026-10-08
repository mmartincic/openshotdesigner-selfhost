import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initProjectLibrary } from './utils/projectLibrary';
import { loadStoredOflSnapshot, refreshOflSnapshotOnline } from './domain/fixtures';
import { hydrateCustomFixtureProfiles } from './domain/fixtures/customProfiles';
import { isServerStorage } from './config/storage';
import { hydrateSyncedLocalKeys, onSyncedKeyChanged } from './domain/storage/syncedLocalKeys';


/**
 * Self-hosted builds keep everything on the server. If it can't be reached at
 * startup, say so plainly and offer a retry — rendering an empty library would
 * look like data loss, and editing it would create projects nobody else sees.
 */
const renderServerUnavailable = (error: unknown) => {
  const root = document.getElementById('root')!;
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#0f172a;color:#e2e8f0;font:14px/1.5 system-ui,sans-serif">
      <div style="max-width:440px;border:1px solid #334155;border-radius:12px;padding:20px;background:#111827">
        <h1 style="margin:0 0 8px;font-size:16px">Can't reach the storage server</h1>
        <p style="margin:0 0 12px;color:#94a3b8">Your projects live on your server, so the app won't open until it can load them.
        Check that you're online and signed in, then try again.</p>
        <pre style="margin:0 0 14px;white-space:pre-wrap;font-size:12px;color:#fca5a5"></pre>
        <button style="padding:6px 12px;border-radius:8px;border:0;background:#0284c7;color:white;font-weight:600;cursor:pointer">Retry</button>
      </div>
    </div>`;
  root.querySelector('pre')!.textContent = message;
  root.querySelector('button')!.addEventListener('click', () => window.location.reload());
};

// Hydrate the project library (IndexedDB, with a localStorage fallback and a
// one-time import of pre-IndexedDB data) before the first render so every
// synchronous read in the app sees a complete library.
void initProjectLibrary()
  .then(() => hydrateSyncedLocalKeys())
  .then(
    () => true,
    (error: unknown) => {
      if (isServerStorage()) {
        renderServerUnavailable(error);
        return false;
      }
      // The library falls back to localStorage internally; never block startup.
      return true;
    },
  )
  .then((ready) => {
    if (!ready) return;
    // Fixture catalog: user profiles first, then the last online OFL snapshot,
    // then (when online and stale) a fresh download — all without blocking render.
    hydrateCustomFixtureProfiles();
    onSyncedKeyChanged('custom_fixture_profiles_v1', hydrateCustomFixtureProfiles);
    void loadStoredOflSnapshot().then(() => refreshOflSnapshotOnline());

    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Offline app shell (plan §5.4): production builds register the service
    // worker so an installed/opened build keeps working without network.
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      const registerServiceWorker = () => {
        navigator.serviceWorker
          .register(`${import.meta.env.BASE_URL}sw.js`)
          .then((registration) => {
            // Check for a newer deploy on every load; the new worker takes
            // over silently and the next navigation serves the new bundle.
            registration.update().catch(() => undefined);
          })
          .catch(() => {
            // Offline support is progressive; registration failure is non-fatal.
          });
      };
      // Project-library hydration is asynchronous. On a fast page the load
      // event may already have fired before this finally block runs; adding a
      // listener at that point waits forever and the app never becomes
      // offline-capable. Register immediately in that case.
      if (document.readyState === 'complete') registerServiceWorker();
      else window.addEventListener('load', registerServiceWorker, { once: true });
    }
  });
