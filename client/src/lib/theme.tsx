/**
 * Global theme infrastructure — Task #4377 (app-wide dark mode capstone).
 *
 * ThemeProvider owns the light/dark/system preference:
 *   - Source of truth is users.theme_preference (via /api/auth/user);
 *     localStorage "nobull-theme" caches it so the inline pre-paint script
 *     in client/index.html can apply `.dark` before first paint (no flash).
 *   - "system" follows prefers-color-scheme live via a matchMedia listener.
 *   - setPreference applies locally at once (optimistic), persists via
 *     PUT /api/users/me/theme, then invalidates the auth query.
 *
 * The `.dark` class goes on <html> (document.documentElement); token values
 * live in client/src/index.css. The Ads OS module-local toggle was absorbed
 * into this provider (its data-ads-theme mechanism is retired).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Keep in lockstep with the inline pre-paint script in client/index.html. */
export const THEME_STORAGE_KEY = "nobull-theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

function applyThemeClass(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

interface ThemeContextValue {
  /** The user's stored choice: light | dark | system. */
  preference: ThemePreference;
  /** What is actually applied right now (system resolved to light/dark). */
  resolved: ResolvedTheme;
  /** Apply + persist a new preference. */
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(),
  );
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredPreference()),
  );

  // Refs so setPreference stays referentially stable.
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  // In-flight persistence writes — while one is pending, a stale auth
  // refetch (e.g. window-focus) must not revert the optimistic choice.
  const pendingWritesRef = useRef(0);

  // Adopt the server-stored preference when the authed user record arrives
  // or changes (sign-in, cross-device edit surfaced by a refetch).
  const serverPreference = user?.themePreference;
  useEffect(() => {
    if (pendingWritesRef.current > 0) return;
    if (isThemePreference(serverPreference)) {
      setPreferenceState((current) =>
        current === serverPreference ? current : serverPreference,
      );
    }
  }, [serverPreference]);

  // Apply the preference: toggle `.dark`, cache for the pre-paint script,
  // and (for "system") follow OS changes live.
  useEffect(() => {
    const next = resolveTheme(preference);
    setResolved(next);
    applyThemeClass(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Storage unavailable (private mode) — theme still applies for the session.
    }

    if (preference !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const sysResolved: ResolvedTheme = mql.matches ? "dark" : "light";
      setResolved(sysResolved);
      applyThemeClass(sysResolved);
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Safari <14 fallback.
    if (typeof (mql as any).addListener === "function") {
      (mql as any).addListener(onChange);
      return () => (mql as any).removeListener(onChange);
    }
  }, [preference]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      if (!isAuthenticatedRef.current) return;
      pendingWritesRef.current += 1;
      apiRequest("PUT", "/api/users/me/theme", { theme: next })
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }))
        .catch((err) => {
          // Non-fatal: the theme is applied locally; it just won't follow
          // the user to other devices until a later save succeeds.
          console.error("[theme] Failed to persist theme preference:", err);
        })
        .finally(() => {
          pendingWritesRef.current -= 1;
        });
    },
    [queryClient],
  );

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
