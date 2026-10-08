import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import type { ProjectSummary } from '../domain/storage/types';
import {
  loadLibrary,
  markSavePending,
  maybeWriteBackupSnapshot,
  setActiveProjectId,
  subscribeProjectWriteConflicts,
  subscribeLibraryChanges,
  subscribeSaveState,
  writeProject,
} from '../utils/projectLibrary';
import { isServerStorage } from '../config/storage';
import { getLastRemoteErrorKind } from '../domain/storage/remote';

export const AUTOSAVE_DEBOUNCE_MS = 300;

const QUOTA_WARNING =
  'Autosave to this browser failed — the project (likely with embedded storyboards) ' +
  'exceeds the local storage limit. Use the download button in the top bar to save your project file.';
const IDB_WARNING =
  'Saving to this browser failed — the storage database rejected the write (usually quota). ' +
  'Export your project file from the top bar so nothing is lost.';
const CONFLICT_WARNING =
  'This project was changed in another browser tab. This tab will not overwrite it; reload before continuing.';
// Keeps the phrase "another browser tab" so App.tsx shows its Reload button.
const SERVER_CONFLICT_WARNING =
  'This project was changed on another device or in another browser tab. ' +
  'This tab will not overwrite it; reload to get the latest version.';
const SERVER_AUTH_WARNING =
  'Saving to your server failed: your sign-in has expired. Your edits are still in this tab — ' +
  'open the app in a new tab to sign in, then come back; saving resumes automatically.';
const SERVER_OFFLINE_WARNING =
  "Can't reach your server right now. Your edits are kept in this tab and will be saved " +
  'automatically when the connection is back — don\'t close this tab until it says Saved.';
const SERVER_ERROR_WARNING =
  'Your server rejected the save. Download the project file from the top bar so nothing is lost.';
/** How often a failed server save is retried while the tab stays open. */
const SERVER_RETRY_MS = 10_000;

const serverWarningFor = (): string => {
  switch (getLastRemoteErrorKind()) {
    case 'conflict':
      return SERVER_CONFLICT_WARNING;
    case 'auth':
      return SERVER_AUTH_WARNING;
    case 'network':
      return SERVER_OFFLINE_WARNING;
    default:
      return SERVER_ERROR_WARNING;
  }
};

/**
 * Debounced persistence slice, extracted from `FloorPlanContext`.
 *
 * The context was 4400+ lines because project content, selection, history,
 * canvas viewport *and* persistence all lived in one component. This hook owns
 * only persistence: debounce + flush on hide/unload + storage warnings +
 * multi-tab conflict surfacing. Behaviour is unchanged — same 300 ms timer,
 * same immediate `markSavePending()` so "Saved locally" never goes stale.
 */
export const useAutosave = (
  project: Project,
  setProjects: (summaries: ProjectSummary[]) => void,
): {
  storageWarning: string | null;
  dismissStorageWarning: () => void;
  persistProjectNow: (target?: Project) => void;
} => {
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const autosaveProjectRef = useRef(project);
  const autosaveTimerRef = useRef<number | null>(null);

  const persistProjectNow = (target: Project = autosaveProjectRef.current) => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    try {
      writeProject(target);
      setActiveProjectId(target.id);
      setProjects(loadLibrary());
      setStorageWarning(null);
      maybeWriteBackupSnapshot(target);
    } catch (error) {
      setStorageWarning(
        error instanceof Error && /another browser tab/i.test(error.message)
          ? error.message
          : QUOTA_WARNING,
      );
    }
  };

  useEffect(() => {
    const previous = autosaveProjectRef.current;
    if (previous.id !== project.id) persistProjectNow(previous);
    autosaveProjectRef.current = project;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    if (previous !== project) markSavePending();
    autosaveTimerRef.current = window.setTimeout(
      () => persistProjectNow(project),
      AUTOSAVE_DEBOUNCE_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    const flush = () => {
      if (autosaveTimerRef.current !== null) persistProjectNow();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    let retryTimer: number | null = null;
    const clearRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const retryNow = () => {
      clearRetry();
      persistProjectNow();
    };
    const unsubscribe = subscribeSaveState((state) => {
      if (state !== 'error') {
        if (state === 'saved') {
          clearRetry();
          // A save went through again: drop an offline/sign-in banner, but
          // never a conflict one (that needs the user to reload).
          setStorageWarning((current) =>
            current === SERVER_OFFLINE_WARNING || current === SERVER_AUTH_WARNING ? null : current,
          );
        }
        return;
      }
      if (!isServerStorage()) {
        setStorageWarning(IDB_WARNING);
        return;
      }
      setStorageWarning(serverWarningFor());
      // Offline / signed out / server hiccup: keep retrying the whole project
      // in the background. A conflict is final until the user reloads.
      if (getLastRemoteErrorKind() !== 'conflict' && retryTimer === null) {
        retryTimer = window.setTimeout(retryNow, SERVER_RETRY_MS);
      }
    });
    const onOnline = () => {
      if (retryTimer !== null) retryNow();
    };
    window.addEventListener('online', onOnline);
    return () => {
      flush();
      clearRetry();
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      subscribeProjectWriteConflicts((projectId) => {
        if (projectId !== autosaveProjectRef.current.id) return;
        setStorageWarning(isServerStorage() ? SERVER_CONFLICT_WARNING : CONFLICT_WARNING);
      }),
    [],
  );

  // Self-hosted: projects created, renamed or deleted on another device show
  // up on this device's dashboard without a reload.
  useEffect(() => subscribeLibraryChanges(() => setProjects(loadLibrary())), [setProjects]);

  return {
    storageWarning,
    dismissStorageWarning: () => setStorageWarning(null),
    persistProjectNow,
  };
};
