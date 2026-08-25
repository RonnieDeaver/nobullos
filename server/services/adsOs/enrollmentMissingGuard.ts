// @db-pool-intent: worker
//
// Ads OS — ClickUp enrollment vs Google Ads MCC guard.
//
// Once per ET day, compare every live ClickUp-enrolled GAds/LSA CID (including
// Off accounts) with the MCC's ENABLED non-manager account list. A missing CID
// can mean the account was closed, transferred to another MCC, or mis-keyed in
// ClickUp; without this guard resolve() merely logs and drops it from dashboards.
//
// The evaluator follows the same review-approved pattern as labelDriftGuard:
// deployment-gated periodic catch-up, live kill switch, worker-pool attribution,
// cross-instance advisory lock, and a durable per-day ledger. The Ads OS Slack
// webhook and each responsible-admin bell are awaited and ledgered separately,
// so a failed channel/recipient leaves only that delivery dimension retryable.

import { runWithWorkerDb, withDbAttribution } from "../../db";
import { getSystemSetting } from "../../storage/settingsStorage";
import { isRunningInDeployment } from "../../lib/deploymentEnv";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import type { ClientBlock } from "./clickUpDirectory";
import type { MccAccounts } from "./enrollment";
import type { Product } from "./types";

export const MCC_ENROLLMENT_NOTIFICATION_ID =
  "system.ads_os.mcc_enrollment_missing";
export const MCC_ENROLLMENT_STATE_DEDUPE_KEY =
  "ads_os.mcc_enrollment_missing:state";
export const MCC_ENROLLMENT_ALERT_DEDUPE_PREFIX =
  "ads_os.mcc_enrollment_missing:";
export const MCC_ENROLLMENT_ENABLED_SETTING =
  "ads_os_mcc_enrollment_guard_enabled";
export const MCC_ENROLLMENT_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const MCC_ENROLLMENT_PAGE_PATH = "/ads-os";

export interface MissingMccEnrollment {
  cid: string;
  clientName: string;
  products: Product[];
}

/** Pure comparison used by the daily guard and its no-egress contract test. */
export function findMissingClickUpEnrolledAccounts(
  blocks: ClientBlock[],
  mcc: MccAccounts,
): MissingMccEnrollment[] {
  const byCid = new Map<string, { clients: Set<string>; products: Set<Product> }>();
  const add = (rawCid: string, clientName: string, product: Product): void => {
    const cid = rawCid.replace(/\D/g, "");
    if (!cid) return;
    const entry = byCid.get(cid) ?? {
      clients: new Set<string>(),
      products: new Set<Product>(),
    };
    entry.clients.add(clientName);
    entry.products.add(product);
    byCid.set(cid, entry);
  };

  for (const block of blocks) {
    for (const cid of block.gads_cids) add(cid, block.name, "gads");
    for (const cid of block.lsa_cids) add(cid, block.name, "lsa");
  }

  return [...byCid.entries()]
    .filter(([cid]) => !mcc.has(cid))
    .map(([cid, entry]) => ({
      cid,
      clientName: [...entry.clients].sort().join(" / "),
      products: [...entry.products].sort(),
    }))
    .sort((a, b) => a.cid.localeCompare(b.cid));
}

export interface MccEnrollmentGuardDeps {
  scan: () => Promise<MissingMccEnrollment[]>;
  getState: () => Promise<{ metadataJson?: unknown } | undefined>;
  upsertState: (patch: {
    state: "healthy" | "unhealthy";
    failureType?: string | null;
    lastNotifiedAt?: Date | null;
    metadataJson?: unknown;
  }) => Promise<unknown>;
  getRecipients: () => Promise<string[]>;
  notifyUser: (
    userId: string,
    options: {
      category: "system";
      title: string;
      body: string;
      deepLink: string;
      dedupeKey: string;
      metadata: Record<string, unknown>;
    },
  ) => Promise<unknown | null>;
  postSlack: (text: string) => Promise<{ sent: boolean; reason?: string }>;
  acquireEvaluatorLock: () => Promise<{ release: () => Promise<void> } | null>;
  isEnabled: () => Promise<boolean>;
}

const defaultDeps: MccEnrollmentGuardDeps = {
  scan: async () => {
    const directory = await import("./clickUpDirectory");
    const { mccEnabledAccounts } = await import("./enrollment");
    const bundle = await directory.getClientDirectory();
    if (!directory.bundleIsLive()) {
      throw new Error("ClickUp Client List directory is not currently live");
    }
    return findMissingClickUpEnrolledAccounts(
      bundle.blocks,
      await mccEnabledAccounts(),
    );
  },
  getState: async () => {
    const { getHealthState } = await import("../../storage/notificationsStorage");
    return getHealthState(
      MCC_ENROLLMENT_NOTIFICATION_ID,
      MCC_ENROLLMENT_STATE_DEDUPE_KEY,
    );
  },
  upsertState: async (patch) => {
    const { upsertHealthState } = await import("../../storage/notificationsStorage");
    return upsertHealthState({
      notificationId: MCC_ENROLLMENT_NOTIFICATION_ID,
      dedupeKey: MCC_ENROLLMENT_STATE_DEDUPE_KEY,
      ...patch,
    });
  },
  getRecipients: async () => {
    const { getResponsibleAdminsForAlert } = await import(
      "../notifications/recipients"
    );
    return getResponsibleAdminsForAlert();
  },
  notifyUser: async (userId, options) => {
    const { notifyUser } = await import("../notifications/userInbox");
    return notifyUser(userId, options);
  },
  postSlack: async (text) => {
    const { postSlackMessage } = await import("./slackWebhook");
    return postSlackMessage({
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    });
  },
  acquireEvaluatorLock: async () => {
    const { acquireWorkerSingletonLock } = await import("../crossInstanceLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("../workerConfig");
    return acquireWorkerSingletonLock(
      "ads_os_mcc_enrollment_guard",
      "[adsOsMccEnrollmentGuard]",
      {
        maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.ads_os_mcc_enrollment_guard,
      },
    );
  },
  isEnabled: async () => {
    const row = await getSystemSetting(MCC_ENROLLMENT_ENABLED_SETTING);
    const value = row?.value;
    return (
      value === null ||
      value === undefined ||
      value === "1" ||
      value === "true"
    );
  },
};

let deps: MccEnrollmentGuardDeps = { ...defaultDeps };
let evaluatorTimer: ReturnType<typeof setInterval> | null = null;

export function __setMccEnrollmentGuardDepsForTest(
  overrides: Partial<MccEnrollmentGuardDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function __resetMccEnrollmentGuardDepsForTest(): void {
  deps = { ...defaultDeps };
}

/** ET calendar day used in state and delivery dedupe keys. */
export function mccEnrollmentDayStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function alertText(account: MissingMccEnrollment): string {
  const products = account.products
    .map((product) => (product === "gads" ? "Google Ads" : "LSA"))
    .join(" + ");
  return (
    `Ads OS enrollment mismatch: ${account.clientName} (${account.cid}) is ` +
    `enrolled in ClickUp for ${products}, but the CID is not an ENABLED account ` +
    `under the Google Ads MCC. The account may be closed, transferred, or ` +
    `mis-keyed in ClickUp. Check the ClickUp Client List and the MCC before ` +
    `changing enrollment.`
  );
}

export interface MccEnrollmentEvaluationResult {
  day: string;
  alreadyComplete: boolean;
  missingCids: string[];
  notified: string[];
  failed: string[];
}

/**
 * Evaluate one ET day. Never throws: failed source reads are non-observations,
 * while failed deliveries leave the day open so the next tick retries only the
 * Slack/CID or bell/CID/user dimensions absent from the durable ledger.
 */
export async function evaluateMccEnrollmentGuard(
  now: Date = new Date(),
): Promise<MccEnrollmentEvaluationResult | null> {
  try {
    const day = mccEnrollmentDayStamp(now);
    const state = await deps.getState();
    const metadata = (state?.metadataJson ?? {}) as Record<string, unknown>;
    if (metadata.completedDay === day) {
      return {
        day,
        alreadyComplete: true,
        missingCids: [],
        notified: [],
        failed: [],
      };
    }

    const ledger = new Set<string>(
      metadata.ledgerDay === day && Array.isArray(metadata.ledger)
        ? (metadata.ledger as string[])
        : [],
    );
    const missing = await deps.scan();
    const notified: string[] = [];
    const failed: string[] = [];
    const recipients = missing.length > 0 ? await deps.getRecipients() : [];
    const persistDeliveryProgress = async (): Promise<void> => {
      await deps.upsertState({
        state: missing.length > 0 ? "unhealthy" : "healthy",
        failureType: "enrolled_account_missing_from_mcc",
        lastNotifiedAt: now,
        metadataJson: {
          completedDay: metadata.completedDay ?? null,
          ledgerDay: day,
          ledger: [...ledger].sort(),
          missingAccounts: missing.map((account) => ({
            cid: account.cid,
            clientName: account.clientName,
            products: account.products,
          })),
          lastEvaluatedAt: now.toISOString(),
        },
      });
    };

    if (missing.length > 0 && recipients.length === 0) {
      console.warn(
        "[adsOsMccEnrollmentGuard] no responsible admins found — bell alerts have no recipients",
      );
    }

    for (const account of missing) {
      const text = alertText(account);
      const alertMetadata = {
        day,
        customerId: account.cid,
        clientName: account.clientName,
        products: account.products,
      };

      if (recipients.length === 0) {
        failed.push(`${account.cid}:bell:no_recipients`);
      }
      for (const userId of recipients) {
        const ledgerKey = `bell:${account.cid}:${userId}`;
        if (ledger.has(ledgerKey)) continue;
        try {
          const result = await deps.notifyUser(userId, {
            category: "system",
            title: `Google Ads account missing: ${account.clientName} (${account.cid})`,
            body: text,
            deepLink: MCC_ENROLLMENT_PAGE_PATH,
            dedupeKey:
              `${MCC_ENROLLMENT_ALERT_DEDUPE_PREFIX}${day}:` +
              `${account.cid}:${userId}`,
            metadata: {
              ...alertMetadata,
              channel: "bell",
            },
          });
          if (result === null) {
            failed.push(`${account.cid}:bell:${userId}`);
            console.warn(
              `[adsOsMccEnrollmentGuard] bell delivery incomplete for ` +
                `${account.cid}:${userId}`,
            );
          } else {
            ledger.add(ledgerKey);
            notified.push(ledgerKey);
            // Persist after every side effect rather than at the end of the
            // portfolio. notifyUser's own dedupe key also makes a retry after
            // an uncertain DB response intrinsically idempotent for bells.
            await persistDeliveryProgress();
          }
        } catch (err: any) {
          failed.push(`${account.cid}:bell:${userId}`);
          console.warn(
            `[adsOsMccEnrollmentGuard] bell notify failed for ` +
              `${account.cid}:${userId}: ${err?.message ?? err}`,
          );
        }
      }

      const slackLedgerKey = `slack:${account.cid}`;
      if (!ledger.has(slackLedgerKey)) {
        try {
          const result = await deps.postSlack(text);
          if (result.sent) {
            ledger.add(slackLedgerKey);
            notified.push(slackLedgerKey);
            // Incoming Slack webhooks do not accept idempotency keys, so
            // alerting intentionally favors at-least-once over claim-before-
            // send (which could silently lose the alert after a crash).
            await persistDeliveryProgress();
          } else {
            failed.push(`${account.cid}:slack`);
            console.warn(
              `[adsOsMccEnrollmentGuard] Slack delivery incomplete for ` +
                `${account.cid}: ${result.reason ?? "unknown"}`,
            );
          }
        } catch (err: any) {
          failed.push(`${account.cid}:slack`);
          console.warn(
            `[adsOsMccEnrollmentGuard] Slack notify failed for ${account.cid}: ` +
              `${err?.message ?? err}`,
          );
        }
      }
    }

    const complete = failed.length === 0;
    await deps.upsertState({
      state: missing.length > 0 ? "unhealthy" : "healthy",
      failureType: "enrolled_account_missing_from_mcc",
      lastNotifiedAt: notified.length > 0 ? now : undefined,
      metadataJson: {
        completedDay: complete ? day : (metadata.completedDay ?? null),
        ledgerDay: day,
        ledger: [...ledger],
        missingAccounts: missing.map((account) => ({
          cid: account.cid,
          clientName: account.clientName,
          products: account.products,
        })),
        lastEvaluatedAt: now.toISOString(),
      },
    });

    if (missing.length > 0) {
      console.warn(
        `[adsOsMccEnrollmentGuard] day ${day}: ${missing.length} enrolled CID(s) ` +
          `missing from the ENABLED MCC list; ${notified.length} delivery dimension(s) completed` +
          (failed.length ? `, ${failed.length} will retry` : ""),
      );
    }

    return {
      day,
      alreadyComplete: false,
      missingCids: missing.map((account) => account.cid),
      notified,
      failed,
    };
  } catch (err: any) {
    console.warn(
      `[adsOsMccEnrollmentGuard] evaluation failed (non-observation): ` +
        `${err?.message ?? err}`,
    );
    return null;
  }
}

export async function runMccEnrollmentGuardPassOnce(
  opts: { now?: Date } = {},
): Promise<MccEnrollmentEvaluationResult | null> {
  let lock: { release: () => Promise<void> } | null = null;
  try {
    if (!(await deps.isEnabled())) return null;
    lock = await deps.acquireEvaluatorLock();
    if (!lock) return null;
    return await runWithWorkerDb(() =>
      withDbAttribution("scheduler:ads-os-mcc-enrollment-guard", () =>
        evaluateMccEnrollmentGuard(opts.now ?? new Date()),
      ),
    );
  } catch (err: any) {
    console.warn(
      `[adsOsMccEnrollmentGuard] periodic pass failed: ${err?.message ?? err}`,
    );
    return null;
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {
        // Best-effort; the bounded lock watchdog reclaims a stuck session.
      }
    }
  }
}

function isForceEnabled(): boolean {
  const value = process.env.ADS_OS_MCC_ENROLLMENT_GUARD_FORCE_ENABLE;
  return value === "1" || value === "true";
}

export function startMccEnrollmentGuardScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
    console.log("[adsOsMccEnrollmentGuard] test env — evaluator disabled");
    return;
  }
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[adsOsMccEnrollmentGuard] not a deployment — evaluator disabled " +
        "(set ADS_OS_MCC_ENROLLMENT_GUARD_FORCE_ENABLE=1 to force)",
    );
    return;
  }
  if (evaluatorTimer) return;
  evaluatorTimer = setInterval(() => {
    void runMccEnrollmentGuardPassOnce();
  }, MCC_ENROLLMENT_TICK_INTERVAL_MS);
  evaluatorTimer.unref?.();
  void runMccEnrollmentGuardPassOnce();
}

export function stopMccEnrollmentGuardScheduler(): void {
  if (evaluatorTimer) clearInterval(evaluatorTimer);
  evaluatorTimer = null;
}

registerModuleStateResetForTest("adsOsMccEnrollmentGuard", () => {
  stopMccEnrollmentGuardScheduler();
  __resetMccEnrollmentGuardDepsForTest();
});