import { useState, useEffect, useRef } from "react";
import { CLIENT_DEFERRED_QUERY_STEP_DELAY_MS } from "@/lib/queryClient";

export function useDeferredEnabled(
  primaryReady: boolean,
  stepIndex: number = 0,
): boolean {
  const [enabled, setEnabled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!primaryReady) {
      setEnabled(false);
      return;
    }

    const delay = stepIndex * CLIENT_DEFERRED_QUERY_STEP_DELAY_MS;

    if (delay === 0) {
      setEnabled(true);
      return;
    }

    timerRef.current = setTimeout(() => setEnabled(true), delay);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [primaryReady, stepIndex]);

  return enabled;
}
