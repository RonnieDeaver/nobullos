/**
 * lazyWithRetry — drop-in replacement for React.lazy() that retries chunk
 * loads on stale-deploy failures before letting the error bubble to the
 * GlobalErrorBoundary.
 *
 * Behaviour:
 *   1. Attempt to load the chunk.
 *   2. On a chunk-load error, wait RETRY_DELAY_MS and try again (up to
 *      RETRY_COUNT additional attempts).
 *   3. If all retries are exhausted, re-throw so the GlobalErrorBoundary can
 *      attempt an automatic page reload.
 *   4. Non-chunk errors (genuine runtime import failures) propagate
 *      immediately without retrying.
 */

import { lazy } from "react";
import type { ComponentType } from "react";
import { isChunkLoadError } from "./chunkLoadError";

const RETRY_COUNT = 2;
const RETRY_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      try {
        if (attempt > 0) await delay(RETRY_DELAY_MS);
        return await factory();
      } catch (err) {
        lastError = err;
        if (!isChunkLoadError(err)) {
          throw err;
        }
      }
    }
    throw lastError;
  });
}
