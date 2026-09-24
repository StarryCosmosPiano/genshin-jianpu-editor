/** UI appearance is independent of the score model and editor lifecycle. */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "jpeditor.ui.theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let preference: ThemePreference = "system";
let media: MediaQueryList | undefined;
let initialized = false;

function isPreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function resolvedTheme(): ResolvedTheme {
  return preference === "system" ? (media?.matches ? "dark" : "light") : preference;
}

function applyTheme(): void {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#101014" : "#FFFBFF");
  document.dispatchEvent(new CustomEvent("themechange", { detail: { preference, theme } }));
}

/** Call once during startup, before the editor is mounted. Safe to call again. */
export function initializeTheme(): ThemePreference {
  if (initialized) return preference;
  initialized = true;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isPreference(saved)) preference = saved;
  } catch { /* Storage may be disabled in an embedded browser. */ }
  if (typeof matchMedia === "function") {
    media = matchMedia(MEDIA_QUERY);
    media.addEventListener("change", () => {
      if (preference === "system") applyTheme();
    });
  }
  applyTheme();
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  if (!initialized) initializeTheme();
  if (!isPreference(next)) return;
  preference = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep this session's choice. */ }
  applyTheme();
}

export function getThemePreference(): ThemePreference {
  if (!initialized) initializeTheme();
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  if (!initialized) initializeTheme();
  return resolvedTheme();
}
