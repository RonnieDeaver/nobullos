import { useRef, useEffect, useCallback, useState } from "react";

interface UseAutosaveOptions {
  data: string;
  onSave: () => void;
  enabled: boolean;
  debounceMs?: number;
}

export function useAutosave({
  data,
  onSave,
  enabled,
  debounceMs = 1500,
}: UseAutosaveOptions) {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDirtyRef = useRef(false);
  const lastKnownDataRef = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);

  onSaveRef.current = onSave;

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const triggerSave = useCallback(() => {
    if (isDirtyRef.current) {
      isDirtyRef.current = false;
      setPending(false);
      onSaveRef.current();
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearPendingTimer();
      return;
    }

    if (lastKnownDataRef.current === null) {
      lastKnownDataRef.current = data;
      return;
    }

    if (data === lastKnownDataRef.current) return;

    lastKnownDataRef.current = data;
    isDirtyRef.current = true;
    setPending(true);
    clearPendingTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      triggerSave();
    }, debounceMs);
  }, [data, enabled, debounceMs, clearPendingTimer, triggerSave]);

  const markCurrentAsBaseline = useCallback(() => {
    clearPendingTimer();
    lastKnownDataRef.current = null;
    isDirtyRef.current = false;
    setPending(false);
  }, [clearPendingTimer]);

  const flush = useCallback(() => {
    clearPendingTimer();
    triggerSave();
  }, [clearPendingTimer, triggerSave]);

  useEffect(() => {
    return () => {
      clearPendingTimer();
    };
  }, [clearPendingTimer]);

  return { flush, markCurrentAsBaseline, pending };
}
