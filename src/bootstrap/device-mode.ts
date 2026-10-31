/** Workspace presentation is independent from score notation and pointer focus. */
export type WorkspaceModePreference = "auto" | "phone" | "tablet" | "desktop";
export type WorkspaceMode = Exclude<WorkspaceModePreference, "auto">;
export interface WorkspaceModeState {
  preference: WorkspaceModePreference;
  mode: WorkspaceMode;
  touch: boolean;
}

const STORAGE_KEY = "jpeditor:workspace-mode:v1";
let preference: WorkspaceModePreference | null = null;
let initialCoarsePointer: boolean | null = null;
let previous: WorkspaceModeState | null = null;
let initialized = false;

export function resolveWorkspaceMode(preferred: WorkspaceModePreference, width: number, coarse: boolean): WorkspaceMode {
  if (preferred !== "auto") return preferred;
  return width < 768 ? "phone" : coarse ? "tablet" : "desktop";
}

export function getWorkspaceModePreference(): WorkspaceModePreference {
  if (preference) return preference;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "phone" || value === "tablet" || value === "desktop") return preference = value;
  } catch { /* Local storage is optional. */ }
  return preference = "auto";
}

export function getWorkspaceMode(): WorkspaceMode {
  // Capture input capabilities once. Attaching a trackpad/keyboard must not
  // replace a tablet's workspace while a score or settings draft is being used.
  if (initialCoarsePointer === null) initialCoarsePointer = typeof matchMedia === "function"
    && matchMedia("(pointer: coarse)").matches;
  return resolveWorkspaceMode(getWorkspaceModePreference(), typeof window === "undefined" ? 1440 : window.innerWidth,
    initialCoarsePointer);
}

export function isTouchWorkspace(): boolean { return getWorkspaceMode() !== "desktop"; }

export function refreshWorkspaceMode(): WorkspaceModeState {
  const mode = getWorkspaceMode();
  const state = { preference: getWorkspaceModePreference(), mode, touch: mode !== "desktop" };
  if (typeof document !== "undefined") {
    document.documentElement.dataset.workspaceMode = mode;
    document.documentElement.dataset.workspacePreference = state.preference;
    if (!previous || previous.mode !== state.mode || previous.preference !== state.preference) {
      previous = state;
      document.dispatchEvent(new CustomEvent<WorkspaceModeState>("workspace:mode-change", { detail: state }));
    }
  }
  return state;
}

export function setWorkspaceModePreference(value: WorkspaceModePreference): void {
  if (!["auto", "phone", "tablet", "desktop"].includes(value)) return;
  preference = value;
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Still apply this session. */ }
  refreshWorkspaceMode();
}

export function initializeWorkspaceMode(): () => void {
  if (initialized) return () => undefined;
  initialized = true;
  const resize = (): void => { refreshWorkspaceMode(); };
  window.addEventListener("resize", resize);
  refreshWorkspaceMode();
  return () => { window.removeEventListener("resize", resize); initialized = false; };
}
