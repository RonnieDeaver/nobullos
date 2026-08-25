/**
 * Task #5156 — Dependency-free leaf: projection environment resolution.
 *
 * Extracted from clickUpRoleProjection.ts to break the import cycle between
 * clickUpRoleProjection.ts (barrel/staging) and clickUpRoleProjectionAdmin.ts
 * (config/status). Both modules need this type+function; neither depends on
 * the other for it. This file has NO local imports so it can be safely
 * imported by any module in the projection graph.
 */

export type ProjectionEnvironment = "sandbox" | "production" | "unconfigured";

/**
 * Reads CLICKUP_ROLE_PROJECTION_ENVIRONMENT from the process environment and
 * returns the canonical environment token. Absent or unrecognised → "unconfigured".
 */
export function resolveProjectionEnvironment(): ProjectionEnvironment {
  const env = process.env.CLICKUP_ROLE_PROJECTION_ENVIRONMENT;
  if (!env) return "unconfigured";
  if (env === "production") return "production";
  if (env === "sandbox") return "sandbox";
  return "unconfigured";
}

/** Exponential back-off capped at 1 h: 30s, 2m, 10m, 30m, 60m. */
export function projectionRetryDelayMs(attempt: number): number {
  const delays = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
  return delays[Math.min(attempt, delays.length - 1)];
}
