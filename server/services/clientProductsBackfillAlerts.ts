/**
 * Task #1110 — Slack/email alert when the startup client-products
 * normalization backfill (Task #656 / Task #635) drops unrecognized product
 * values.
 *
 * Without this, the only signal is a single console.warn at boot. If a real
 * new product is rolled out and someone forgets to add the alias to
 * `shared/productResolution.ts`, the values silently disappear from every
 * client's `products` array on every restart and nobody notices unless they
 * happen to read the boot log. Routing the same signal through the canonical
 * notifications dispatcher (`notifyByType`) makes it self-correcting.
 *
 * Dedup: persists the last-alerted timestamp in `system_settings` so repeated
 * boot loops / autoscale restarts don't spam the channel. Cooldown default is
 * 6 hours and is overridable via `system_settings`.
 */

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const NOTIFICATION_ID = "infra.client_products_backfill.unknown_values";

export const SETTING_LAST_ALERTED_AT =
  "client_products_backfill:unknown_values_last_alerted_at";
export const SETTING_COOLDOWN_MINUTES =
  "client_products_backfill:unknown_values_alert_cooldown_minutes";

export const DEFAULT_COOLDOWN_MINUTES = 6 * 60; // 6h

type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let dispatcherOverride: NotifyByTypeFn | null = null;

export interface UnknownProductSample {
  clientId: string;
  invalid: string[];
}

export interface UnknownValuesAlertInput {
  totalUnknownValues: number;
  rowsWithUnknownValues: number;
  samples: UnknownProductSample[];
}

export type UnknownValuesAlertDecision =
  | "alerted"
  | "skipped_no_unknown_values"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface UnknownValuesAlertResult {
  decision: UnknownValuesAlertDecision;
  cooldownMinutes: number;
  delivered: boolean;
  skipReason?: string;
}

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export async function getCooldownMinutes(): Promise<number> {
  const row = await getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null);
  return parsePositiveInt(row?.value, DEFAULT_COOLDOWN_MINUTES);
}

function uniqueInvalidValues(samples: UnknownProductSample[]): string[] {
  const set = new Set<string>();
  for (const s of samples) {
    for (const v of s.invalid) set.add(v);
  }
  return Array.from(set);
}

/**
 * Dispatch a "client-products backfill dropped unrecognized values" alert via
 * the canonical notifier. Honors a persisted cooldown window so repeated
 * restarts don't spam admins. Best-effort; never throws.
 */
export async function recordClientProductsUnknownValues(
  input: UnknownValuesAlertInput,
): Promise<UnknownValuesAlertResult> {
  const cooldownMinutes = await getCooldownMinutes();

  if (input.totalUnknownValues <= 0) {
    return {
      decision: "skipped_no_unknown_values",
      cooldownMinutes,
      delivered: false,
    };
  }

  const cooldownMs = cooldownMinutes * 60_000;
  const now = Date.now();

  const lastRow = await getSystemSetting(SETTING_LAST_ALERTED_AT).catch(
    () => null,
  );
  const last = Number(lastRow?.value ?? 0);
  if (Number.isFinite(last) && last > 0 && now - last < cooldownMs) {
    return {
      decision: "skipped_cooldown",
      cooldownMinutes,
      delivered: false,
      skipReason: `last alert ${Math.floor((now - last) / 60_000)}m ago < ${cooldownMinutes}m`,
    };
  }

  const distinctValues = uniqueInvalidValues(input.samples);
  const valueList =
    distinctValues.length === 0
      ? "(none captured in samples)"
      : distinctValues.map((v) => `\`${v}\``).join(", ");
  const sampleClients =
    input.samples.length === 0
      ? "(none captured)"
      : input.samples
          .slice(0, 10)
          .map((s) => `${s.clientId} → [${s.invalid.join(", ")}]`)
          .join("; ");

  const text =
    `:warning: *Startup client-products backfill dropped unrecognized values*\n` +
    `Dropped *${input.totalUnknownValues}* product value(s) across ` +
    `*${input.rowsWithUnknownValues}* client row(s) on boot.\n` +
    `Unrecognized values: ${valueList}\n` +
    `Sample clients: ${sampleClients}\n` +
    `Add aliases to \`shared/productResolution.ts\` if these are real ` +
    `products, otherwise clean the source data.`;

  let delivered = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // Persisted cooldown above already prevents flooding.
        bypassDedupe: true,
        metadata: {
          totalUnknownValues: input.totalUnknownValues,
          rowsWithUnknownValues: input.rowsWithUnknownValues,
          distinctUnknownValues: distinctValues,
          samples: input.samples.slice(0, 10),
          cooldownMinutes,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      "[ClientProductsBackfillAlerts] dispatch failed:",
      err?.message ?? err,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    try {
      await setSystemSetting(SETTING_LAST_ALERTED_AT, String(now));
    } catch (err: any) {
      console.warn(
        "[ClientProductsBackfillAlerts] failed to persist last-alerted timestamp:",
        err?.message ?? err,
      );
    }
    return { decision: "alerted", cooldownMinutes, delivered: true };
  }

  return {
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    cooldownMinutes,
    delivered: false,
    skipReason,
  };
}

export const __testHelpers = {
  setDispatcher(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
