import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export const PERSISTENT_STATE_CHANGED_EVENT = "persistent-state:changed";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function dispatchChanged() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(PERSISTENT_STATE_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

export function usePersistentState<T>(
  storageKey: string | null,
  defaultValue: T,
  isValid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(defaultValue);
  const hydratedKeyRef = useRef<string | null>(null);
  const defaultRef = useRef<T>(defaultValue);
  defaultRef.current = defaultValue;

  useEffect(() => {
    if (!storageKey) {
      hydratedKeyRef.current = null;
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        if (isValid(parsed)) {
          setValue(parsed);
        } else {
          setValue(defaultValue);
        }
      } else {
        setValue(defaultValue);
      }
    } catch {
      setValue(defaultValue);
    }
    hydratedKeyRef.current = storageKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    if (hydratedKeyRef.current !== storageKey) return;
    try {
      const serialized = safeStringify(value);
      const defaultSerialized = safeStringify(defaultRef.current);
      if (serialized === defaultSerialized) {
        const had = window.localStorage.getItem(storageKey) !== null;
        if (had) {
          window.localStorage.removeItem(storageKey);
          dispatchChanged();
        }
      } else {
        const prev = window.localStorage.getItem(storageKey);
        window.localStorage.setItem(storageKey, serialized);
        if (prev !== serialized) {
          dispatchChanged();
        }
      }
    } catch {
      // ignore
    }
  }, [storageKey, value]);

  // Listen for external resets so this state returns to its default value
  // when the user clicks "Reset saved view" elsewhere on the page.
  useEffect(() => {
    if (!storageKey) return;
    if (typeof window === "undefined") return;
    const handler = () => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw === null) {
          setValue(defaultRef.current);
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener(PERSISTENT_STATE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PERSISTENT_STATE_CHANGED_EVENT, handler);
  }, [storageKey]);

  return [value, setValue];
}

export function clearPersistedKeys(opts: {
  keys?: readonly (string | null | undefined)[];
  prefixes?: readonly string[];
}): boolean {
  if (typeof window === "undefined") return false;
  let removed = false;
  try {
    for (const key of opts.keys ?? []) {
      if (!key) continue;
      if (window.localStorage.getItem(key) !== null) {
        window.localStorage.removeItem(key);
        removed = true;
      }
    }
    const prefixes = opts.prefixes ?? [];
    if (prefixes.length > 0) {
      const matched: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (prefixes.some(p => k.startsWith(p))) matched.push(k);
      }
      for (const k of matched) {
        window.localStorage.removeItem(k);
        removed = true;
      }
    }
  } catch {
    // ignore
  }
  if (removed) dispatchChanged();
  return removed;
}

export function hasPersistedKeys(opts: {
  keys?: readonly (string | null | undefined)[];
  prefixes?: readonly string[];
}): boolean {
  if (typeof window === "undefined") return false;
  try {
    for (const key of opts.keys ?? []) {
      if (!key) continue;
      if (window.localStorage.getItem(key) !== null) return true;
    }
    const prefixes = opts.prefixes ?? [];
    if (prefixes.length > 0) {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (prefixes.some(p => k.startsWith(p))) return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}
