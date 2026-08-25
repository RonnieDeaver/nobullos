/**
 * Task #1103 — Alert ops in Slack when the booking schema goes unhealthy.
 *
 * Task #865 surfaces missing booking tables / constraints in the admin
 * UI (the `/api/admin/booking/health` `schemaReadiness` block), but ops
 * still has to be looking at the page to notice. This watcher polls the
 * cached readiness snapshot (refreshed each tick via
 * `recheckBookingSchemaReadiness`) and fires a Slack alert (via the
 * unified `notifyByType` dispatcher) the moment `ready` flips
 * `true → false` — e.g. after a deploy where 0034-0036 didn't run, the
 * `booking_pages` table was dropped, or the EXCLUDE / UNIQUE constraints
 * disappeared. A recovery message posts when readiness flips back.
 *
 * Behaviour is gated by the `booking_schema_readiness_alert_enabled`
 * `system_settings` kill switch (default on; off-tokens are
 * `false`/`0`/`off`/`no`) so it can be silenced without a deploy.
 *
 * Channel resolution is owned by the dispatcher (notification id
 * `infra.booking.schema_unhealthy` → `notification_settings` →
 * `rate_limit_alert_slack_channel_id` legacy fallback).
 */
import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  getBookingSchemaReadiness,
  recheckBookingSchemaReadiness,
  type BookingSchemaReadiness,
} from "./bookingSchemaReadiness";

const NOTIFICATION_ID = "infra.booking.schema_unhealthy";

export const SETTING_ENABLED = "booking_schema_readiness_alert_enabled";

const CHECK_INTERVAL_MS = 60_000;

const TABLE_LABELS: Record<keyof BookingSchemaReadiness["tables"], string> = {
  bookingPages: "booking_pages",
  bookingAvailabilityRules: "booking_availability_rules",
  bookingAvailabilityOverrides: "booking_availability_overrides",
  scheduledMeetings: "scheduled_meetings",
  googleCalendarCredentials: "google_calendar_credentials",
  bookingClientTokens: "booking_client_tokens",
};

const CONSTRAINT_LABELS: Record<keyof BookingSchemaReadiness["constraints"], string> = {
  bookingPagesAccountManagerUnique: "booking_pages_account_manager_user_id_unique",
  scheduledMeetingsNoOverlap: "scheduled_meetings_no_overlap",
};

const OPERATOR_ACTION = "Apply booking migrations 0034-0036.";

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function isBookingSchemaAlertEnabled(): Promise<boolean> {
  const row = await getSystemSetting(SETTING_ENABLED).catch(() => null);
  return parseBool(row?.value, true);
}

function listMissing(snap: BookingSchemaReadiness): {
  tables: string[];
  constraints: string[];
} {
  const tables: string[] = [];
  for (const k of Object.keys(TABLE_LABELS) as Array<keyof typeof TABLE_LABELS>) {
    if (!snap.tables[k]) tables.push(TABLE_LABELS[k]);
  }
  const constraints: string[] = [];
  for (const k of Object.keys(CONSTRAINT_LABELS) as Array<keyof typeof CONSTRAINT_LABELS>) {
    if (!snap.constraints[k]) constraints.push(CONSTRAINT_LABELS[k]);
  }
  return { tables, constraints };
}

function buildBookingAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/booking#schema-readiness";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildFiringText(snap: BookingSchemaReadiness): string {
  const { tables, constraints } = listMissing(snap);
  const lines: string[] = [
    `:rotating_light: *Booking schema is unhealthy*`,
    `• Operator action: ${OPERATOR_ACTION}`,
  ];
  if (tables.length) {
    lines.push(
      `• Missing tables: ${tables.map((t) => "`" + t + "`").join(", ")}`,
    );
  }
  if (constraints.length) {
    lines.push(
      `• Missing constraints: ${constraints.map((c) => "`" + c + "`").join(", ")}`,
    );
  }
  if (snap.lastError) {
    lines.push(`• Last probe error: ${snap.lastError}`);
  }
  lines.push(`• Booking admin: ${buildBookingAdminLink()}`);
  return lines.join("\n");
}

function buildRecoveryText(): string {
  return [
    `:white_check_mark: *Booking schema recovered*`,
    `• All required booking tables and constraints are present.`,
    `• Booking admin: ${buildBookingAdminLink()}`,
  ].join("\n");
}

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let probeOverride: (() => Promise<BookingSchemaReadiness>) | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

/**
 * In-process record of the most recently observed `ready` value. `null`
 * means we haven't observed readiness at all yet — the first observation
 * establishes the baseline without firing (a freshly-booted server that
 * is already unhealthy is covered by the boot-time log warnings; we
 * only alert on transitions).
 */
let lastReady: boolean | null = null;

/**
 * The watcher's "fully healthy" predicate is strictly stronger than
 * `BookingSchemaReadiness.ready`. The cached `ready` flag in
 * `bookingSchemaReadiness.ts` is computed from table presence only —
 * constraints are reported separately so the booking routes can
 * translate a missing-table failure into a 503 without making
 * constraint regressions block traffic. For the *Slack alert* we want
 * a louder definition: a missing EXCLUDE / UNIQUE constraint also
 * counts as unhealthy because the booking saga then runs in a
 * degraded mode (only the application-level advisory lock prevents
 * double-booking).
 */
function isFullyHealthy(snap: BookingSchemaReadiness): boolean {
  if (!snap.ready) return false;
  for (const k of Object.keys(CONSTRAINT_LABELS) as Array<keyof typeof CONSTRAINT_LABELS>) {
    if (!snap.constraints[k]) return false;
  }
  return true;
}

export type BookingSchemaAlertDecision =
  | "alerted_unhealthy"
  | "alerted_recovered"
  | "skipped_disabled"
  | "skipped_no_transition"
  | "skipped_baseline_seeded"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface BookingSchemaAlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  /**
   * The watcher's stricter "fully healthy" verdict (tables AND
   * constraints). NOT the same as `BookingSchemaReadiness.ready`,
   * which only checks tables — see `isFullyHealthy` above.
   */
  ready: boolean;
  previousReady: boolean | null;
  decision: BookingSchemaAlertDecision;
  skipReason?: string;
  missingTables: string[];
  missingConstraints: string[];
}

async function dispatch(
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      { triggerSource: "alert_service", bypassDedupe: true, metadata },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    return {
      delivered: false,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

/**
 * One pass: re-probe the booking schema, then fire a transition alert
 * if `ready` flipped since the last observation.
 */
export async function checkBookingSchemaReadinessAlert(
  now: number = Date.now(),
): Promise<BookingSchemaAlertCheckResult> {
  const enabled = await isBookingSchemaAlertEnabled();
  const snap = probeOverride
    ? await probeOverride()
    : await recheckBookingSchemaReadiness();
  const { tables: missingTables, constraints: missingConstraints } =
    listMissing(snap);
  const fullyHealthy = isFullyHealthy(snap);

  const result: BookingSchemaAlertCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled,
    ready: fullyHealthy,
    previousReady: lastReady,
    decision: "skipped_no_transition",
    missingTables,
    missingConstraints,
  };

  if (lastReady === null) {
    lastReady = fullyHealthy;
    result.decision = "skipped_baseline_seeded";
    result.skipReason = "first observation — baseline established";
    return result;
  }

  if (fullyHealthy === lastReady) {
    return result;
  }

  if (!enabled) {
    // Move the baseline forward even when disabled so we don't fire a
    // stale alert the moment the kill switch is flipped back on.
    lastReady = fullyHealthy;
    result.decision = "skipped_disabled";
    result.skipReason = "alert disabled in system_settings";
    return result;
  }

  if (fullyHealthy) {
    // false → true: recovery
    const r = await dispatch(buildRecoveryText(), {
      event: "recovered",
      ready: true,
      previousReady: false,
    });
    // Always advance the baseline on recovery — we don't want to keep
    // retrying a recovery message forever if the dispatcher is muted.
    lastReady = true;
    if (r.delivered) {
      result.decision = "alerted_recovered";
    } else {
      result.decision = r.skipReason?.startsWith("dispatch_error")
        ? "skipped_send_failed"
        : "skipped_dispatcher_skipped";
      result.skipReason = r.skipReason;
    }
  } else {
    // true → false: unhealthy
    const r = await dispatch(buildFiringText(snap), {
      event: "unhealthy",
      ready: false,
      previousReady: true,
      operatorAction: OPERATOR_ACTION,
      missingTables,
      missingConstraints,
      lastError: snap.lastError ?? null,
    });
    if (r.delivered) {
      lastReady = false;
      result.decision = "alerted_unhealthy";
    } else {
      // Keep `lastReady = true` so we retry the unhealthy alert on the
      // next tick rather than silently swallowing it.
      result.decision = r.skipReason?.startsWith("dispatch_error")
        ? "skipped_send_failed"
        : "skipped_dispatcher_skipped";
      result.skipReason = r.skipReason;
    }
  }

  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkBookingSchemaReadinessAlert();
      if (
        r.decision === "alerted_unhealthy" ||
        r.decision === "alerted_recovered"
      ) {
        console.log(
          `[BookingSchemaReadinessAlerts] ${r.decision} ready=${r.ready} ` +
            `missingTables=${r.missingTables.length} ` +
            `missingConstraints=${r.missingConstraints.length}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[BookingSchemaReadinessAlerts] tick failed: ${err?.message}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startBookingSchemaReadinessAlertsScheduler(): void {
  if (interval) return;
  // Seed `lastReady` from the cached snapshot so the boot-time
  // `ensureBookingTables` + `recheckBookingSchemaReadiness` result
  // establishes the baseline before our first tick. Without this,
  // the first periodic tick would itself be the baseline and we'd
  // never alert on a regression that happened during the boot
  // window.
  if (lastReady === null) {
    const seed = getBookingSchemaReadiness();
    if (seed.lastCheckedAt) {
      // Use the same stricter "fully healthy" predicate the watcher
      // uses internally so the seed and per-tick verdicts are
      // consistent — otherwise a boot-time snapshot with all tables
      // present but a missing constraint would seed `lastReady=true`
      // and the very next tick would see an immediate true→false
      // transition.
      lastReady = isFullyHealthy(seed);
    }
  }
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:booking-schema-readiness-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  console.log(
    `[BookingSchemaReadinessAlerts] scheduler started (check every ${
      CHECK_INTERVAL_MS / 60_000
    }min)`,
  );
}

export function stopBookingSchemaReadinessAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  resetForTests(): void {
    lastReady = null;
    dispatcherOverride = null;
    probeOverride = null;
  },
  setLastReady(v: boolean | null): void {
    lastReady = v;
  },
  getLastReady(): boolean | null {
    return lastReady;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setProbeForTests(
    fn: (() => Promise<BookingSchemaReadiness>) | null,
  ): void {
    probeOverride = fn;
  },
};
