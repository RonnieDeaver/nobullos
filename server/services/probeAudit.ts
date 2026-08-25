/**
 * Task #1882 — boot-time alert-probe audit.
 *
 * The LeaseChurnAlerts `raw_communication_records` probe sat broken in
 * production with a wrong column name (`ai_processing_status` instead
 * of the real `processing_status`) and only surfaced because someone
 * happened to read the warn logs. Alert probes are exactly the code
 * path you can't afford to have silently dark — by definition no one
 * notices until the next incident.
 *
 * This module exposes a tiny registry that alert probes opt into at
 * module load. At boot we iterate the registry and run a no-op
 * (`LIMIT 0` / `WHERE false`) variant of each probe's query so schema
 * drift fails loudly on restart instead of silently every tick.
 *
 *   - `registerAlertProbe(name, thunk)` — call at module load.
 *   - `runAlertProbeAudit()` — iterate the registry, log
 *     `[ProbeAudit] OK` / `[ProbeAudit] BROKEN` per probe, return the
 *     per-probe results.
 *   - `runBootAlertProbeAudit()` — wrapper used from boot; gated by
 *     `ALERT_PROBE_AUDIT_ENABLED` (default ON in dev, OFF in prod),
 *     raises a high-severity log when any probe fails, and exits
 *     non-zero when `ALERT_PROBE_AUDIT_FAIL_FAST` is on.
 *
 * Out of scope (per task): auto-healing, rewriting probe queries, or
 * auditing every existing probe in one pass — only the ones that opt
 * in via the registry.
 */

export interface AlertProbe {
  name: string;
  probe: () => Promise<void>;
}

export interface ProbeAuditResult {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

const probes: AlertProbe[] = [];

export function registerAlertProbe(
  name: string,
  probe: () => Promise<void>,
): void {
  if (probes.some((p) => p.name === name)) return;
  probes.push({ name, probe });
}

export function listRegisteredAlertProbes(): readonly AlertProbe[] {
  return probes;
}

export async function runAlertProbeAudit(): Promise<ProbeAuditResult[]> {
  const results: ProbeAuditResult[] = [];
  for (const { name, probe } of probes) {
    const t0 = Date.now();
    try {
      await probe();
      const durationMs = Date.now() - t0;
      results.push({ name, ok: true, durationMs });
      console.log(`[ProbeAudit] OK ${name} (${durationMs}ms)`);
    } catch (err: any) {
      const durationMs = Date.now() - t0;
      const msg = err?.message ?? String(err);
      results.push({ name, ok: false, error: msg, durationMs });
      console.error(`[ProbeAudit] BROKEN ${name} (${durationMs}ms): ${msg}`);
    }
  }
  return results;
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export function isAlertProbeAuditEnabled(): boolean {
  // Default ON in dev/test, OFF in production unless explicitly enabled
  // so a transient infra hiccup at boot can't crash the prod process.
  const isProd = process.env.NODE_ENV === "production";
  return parseBoolEnv(process.env.ALERT_PROBE_AUDIT_ENABLED, !isProd);
}

export function shouldFailFastOnBrokenProbe(): boolean {
  return parseBoolEnv(process.env.ALERT_PROBE_AUDIT_FAIL_FAST, false);
}

export async function runBootAlertProbeAudit(): Promise<ProbeAuditResult[]> {
  if (!isAlertProbeAuditEnabled()) {
    console.log(
      "[ProbeAudit] Skipped — ALERT_PROBE_AUDIT_ENABLED is off (default in production)",
    );
    return [];
  }
  if (probes.length === 0) {
    console.log("[ProbeAudit] No probes registered");
    return [];
  }
  const results = await runAlertProbeAudit();
  const broken = results.filter((r) => !r.ok);
  if (broken.length > 0) {
    const names = broken.map((b) => b.name).join(", ");
    console.error(
      `[ProbeAudit] HIGH SEVERITY — ${broken.length}/${results.length} alert probe(s) broken at boot: ${names}`,
    );
    if (shouldFailFastOnBrokenProbe()) {
      console.error(
        "[ProbeAudit] Exiting non-zero (ALERT_PROBE_AUDIT_FAIL_FAST=true)",
      );
      process.exit(1);
    }
  } else {
    console.log(
      `[ProbeAudit] All ${results.length} registered alert probe(s) OK`,
    );
  }
  return results;
}

export const __testHelpers = {
  resetRegistryForTests(): void {
    probes.length = 0;
  },
};
