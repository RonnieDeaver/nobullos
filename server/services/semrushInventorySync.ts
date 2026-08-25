import { workerDb as db, withDbAttribution } from "../db";
import { PERF } from "../perfConfig";
import {
  sourceEventLog,
  workResultLog,
  clientSemrushIntegrations,
  semrushLocationCampaigns,
} from "@shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";

const WORKER_NAME = "semrush_inventory_sync";
let inventoryTimer: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;
let inventoryRestored = false;

const triggeredNextReportDates = new Set<string>();

export interface SemrushInventoryItem {
  campaignId: string;
  businessName: string;
  campaignName?: string;
  address?: string;
  reportDates: string[];
  lastReportDate: string | null;
  nextReportDate: string | null;
  keywordCount: number;
  schedule?: string;
  createdAt?: string;
}

export interface InventorySnapshot {
  campaigns: SemrushInventoryItem[];
  fetchedAt: string;
}

export interface InventoryDiff {
  newCampaigns: SemrushInventoryItem[];
  removedCampaignIds: string[];
  newReportDates: Array<{
    campaignId: string;
    businessName: string;
    newDates: string[];
  }>;
  passedNextReportDate: Array<{
    campaignId: string;
    businessName: string;
    nextReportDate: string;
  }>;
}

let previousInventory: InventorySnapshot | null = null;

async function restoreInventoryFromDb(): Promise<void> {
  if (inventoryRestored) return;
  inventoryRestored = true;
  try {
    const [latestEvent] = await db
      .select({
        payloadJson: sourceEventLog.payloadJson,
        receivedAt: sourceEventLog.receivedAt,
      })
      .from(sourceEventLog)
      .where(
        and(
          eq(sourceEventLog.sourceSystem, "semrush"),
          eq(sourceEventLog.sourceEventType, "inventory_sync"),
        ),
      )
      .orderBy(desc(sourceEventLog.receivedAt))
      .limit(1);

    if (latestEvent?.payloadJson) {
      const payload = latestEvent.payloadJson as any;
      if (Array.isArray(payload.campaigns)) {
        previousInventory = {
          campaigns: payload.campaigns.map((c: any) => ({
            campaignId: c.campaignId,
            businessName: c.businessName || "Unknown",
            reportDates: [],
            lastReportDate: c.lastReportDate || null,
            nextReportDate: c.nextReportDate || null,
            keywordCount: c.keywordCount || 0,
            reportDateCount: c.reportDateCount || 0,
          })),
          fetchedAt: payload.fetchedAt || latestEvent.receivedAt.toISOString(),
        };
        console.log(
          `[${WORKER_NAME}] Restored previous inventory from DB: ${previousInventory.campaigns.length} campaigns, fetched at ${previousInventory.fetchedAt}`,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      `[${WORKER_NAME}] Failed to restore inventory from DB (non-fatal): ${err?.message}`,
    );
  }
}

function estimateNextReportDate(reportDates: string[]): string | null {
  if (reportDates.length < 2) return null;
  const sorted = reportDates
    .map((d) => new Date(d).getTime())
    .sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  if (gap <= 0) return null;
  return new Date(sorted[0] + gap).toISOString();
}

export async function fetchInventory(): Promise<InventorySnapshot> {
  const { workerLog } = await import("./workerLogger");
  const { listCampaigns, getCampaign } = await import("./semrushApi");

  workerLog({ worker: WORKER_NAME, event: "worker_started" });

  const campaigns = await listCampaigns();
  const items: SemrushInventoryItem[] = [];

  for (const camp of campaigns) {
    try {
      const detail = await getCampaign(camp.id);
      const reportDates: string[] = Array.isArray(detail.reportDates)
        ? detail.reportDates
        : [];
      const lastReportDate = reportDates.length > 0 ? reportDates[0] : null;
      const nextReportDate = estimateNextReportDate(reportDates);

      items.push({
        campaignId: camp.id,
        businessName: camp.businessName || detail.businessName || "Unknown",
        campaignName: camp.campaignName || detail.name,
        address: camp.address || detail.address,
        reportDates,
        lastReportDate,
        nextReportDate,
        keywordCount: detail.keywords?.length ?? camp.keywords?.length ?? 0,
        schedule: detail.schedule || camp.schedule,
        createdAt: detail.createdAt || camp.createdAt,
      });
    } catch (err: any) {
      console.warn(
        `[${WORKER_NAME}] Failed to fetch detail for campaign ${camp.id}: ${err?.message}`,
      );
      items.push({
        campaignId: camp.id,
        businessName: camp.businessName || "Unknown",
        campaignName: camp.campaignName,
        address: camp.address,
        reportDates: [],
        lastReportDate: null,
        nextReportDate: null,
        keywordCount: camp.keywords?.length ?? 0,
        schedule: camp.schedule,
        createdAt: camp.createdAt,
      });
    }
  }

  return {
    campaigns: items,
    fetchedAt: new Date().toISOString(),
  };
}

export function diffInventory(
  previous: InventorySnapshot | null,
  current: InventorySnapshot,
): InventoryDiff {
  const diff: InventoryDiff = {
    newCampaigns: [],
    removedCampaignIds: [],
    newReportDates: [],
    passedNextReportDate: [],
  };

  if (!previous) {
    return diff;
  }

  const prevMap = new Map(previous.campaigns.map((c) => [c.campaignId, c]));
  const currMap = new Map(current.campaigns.map((c) => [c.campaignId, c]));

  for (const curr of current.campaigns) {
    const prev = prevMap.get(curr.campaignId);
    if (!prev) {
      diff.newCampaigns.push(curr);
      continue;
    }

    const prevDateSet = new Set(prev.reportDates);
    const newDates = curr.reportDates.filter((d) => !prevDateSet.has(d));
    if (newDates.length > 0) {
      diff.newReportDates.push({
        campaignId: curr.campaignId,
        businessName: curr.businessName,
        newDates,
      });
    }

    const triggerKey = `${curr.campaignId}:${prev.nextReportDate}`;
    if (
      prev.nextReportDate &&
      new Date(prev.nextReportDate).getTime() <= Date.now() &&
      !triggeredNextReportDates.has(triggerKey)
    ) {
      diff.passedNextReportDate.push({
        campaignId: curr.campaignId,
        businessName: curr.businessName,
        nextReportDate: prev.nextReportDate,
      });
    }
  }

  for (const prev of previous.campaigns) {
    if (!currMap.has(prev.campaignId)) {
      diff.removedCampaignIds.push(prev.campaignId);
    }
  }

  return diff;
}

async function persistInventoryEvent(
  inventory: InventorySnapshot,
  diff: InventoryDiff,
): Promise<string> {
  const dedupeKey = `semrush:inventory:${inventory.fetchedAt}`;

  const [event] = await db
    .insert(sourceEventLog)
    .values({
      sourceSystem: "semrush",
      sourceEventType: "inventory_sync",
      sourceObjectId: `inventory:${inventory.fetchedAt}`,
      dedupeKey,
      payloadJson: {
        campaignCount: inventory.campaigns.length,
        campaigns: inventory.campaigns.map((c) => ({
          campaignId: c.campaignId,
          businessName: c.businessName,
          lastReportDate: c.lastReportDate,
          nextReportDate: c.nextReportDate,
          keywordCount: c.keywordCount,
          reportDateCount: c.reportDates.length,
        })),
        fetchedAt: inventory.fetchedAt,
      },
      normalizedIdentityKeysJson: {
        campaignIds: inventory.campaigns.map((c) => c.campaignId),
      },
      status: "normalized",
      normalizedAt: new Date(),
    })
    .returning({ id: sourceEventLog.id });

  if (
    diff.newCampaigns.length > 0 ||
    diff.newReportDates.length > 0 ||
    diff.removedCampaignIds.length > 0 ||
    diff.passedNextReportDate.length > 0
  ) {
    await db.insert(workResultLog).values({
      sourceEventId: event.id,
      sourceSystem: "semrush",
      resultType: "inventory_diff",
      resultJson: {
        newCampaigns: diff.newCampaigns.map((c) => ({
          campaignId: c.campaignId,
          businessName: c.businessName,
        })),
        removedCampaignIds: diff.removedCampaignIds,
        newReportDates: diff.newReportDates,
        passedNextReportDate: diff.passedNextReportDate,
      },
      status: "completed",
    });
  }

  const hasActionableDiff =
    diff.newCampaigns.length > 0 ||
    diff.newReportDates.length > 0 ||
    diff.passedNextReportDate.length > 0;

  const refreshEnabled = PERF.SEMRUSH_REPORT_REFRESH_ENABLED;

  let finalStatus: string;
  if (!hasActionableDiff) {
    finalStatus = "applied";
  } else if (!refreshEnabled) {
    finalStatus = "ignored";
  } else {
    finalStatus = "ready_to_apply";
  }

  await db
    .update(sourceEventLog)
    .set({
      status: finalStatus,
      appliedAt: finalStatus === "applied" ? new Date() : undefined,
      errorMessage:
        finalStatus === "ignored"
          ? "Report refresh disabled (SEMRUSH_REPORT_REFRESH_ENABLED=false)"
          : undefined,
      updatedAt: new Date(),
    })
    .where(eq(sourceEventLog.id, event.id));

  return event.id;
}

async function enqueueRefreshWork(diff: InventoryDiff): Promise<number> {
  if (!PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
    console.log(
      `[${WORKER_NAME}] Report-driven refresh is disabled, skipping enqueue`,
    );
    return 0;
  }

  // Task #1784: pause guard at the enqueue site. The 4h inventory-sync
  // setInterval keeps firing during a queue-drain pause; without this
  // short-circuit it would keep adding pending rows that no worker can
  // claim.
  const { isQueuePaused } = await import("./queueDrainControl");
  if (isQueuePaused("semrush_report_refresh")) {
    const totalCandidates =
      diff.newCampaigns.length +
      diff.newReportDates.length +
      diff.passedNextReportDate.length;
    try {
      const { workerLog } = await import("./workerLogger");
      workerLog({
        worker: "semrush_report_refresh",
        event: "semrush_refresh_enqueue_skipped_queue_paused",
        workloadClass: "ingestion",
        reason: "inventory_sync_diff",
        candidateCount: totalCandidates,
      });
    } catch {}
    return 0;
  }

  const { enqueueJob } = await import("./workScheduler");
  const { evaluateRefreshGate, resolveClientIdForCampaign, lastAppliedAtForCampaign } =
    await import("./semrushCadenceGate");
  // Task #1973: when a campaign's last cached keyword inventory is
  // incomplete, force `lastRefreshedAt=null` into the demand gate so
  // the staleness check fires and the campaign is re-enqueued. Without
  // this, a fresh-but-incomplete cache entry would suppress the
  // refresh and tiles would keep rendering "connection error".
  const { getCachedKeywordInventoryMeta } = await import("./semrushApi");
  let enqueued = 0;

  // Task #1785: per-candidate demand gate. Resolves the owning client
  // (via semrush_location_campaigns) and the last-applied timestamp
  // (via semrush_last_applied_hashes) so the stale + active gates run
  // for every inventory-diff enqueue, not just the tenant-wide tick.
  const allCampaignIds = [
    ...diff.newCampaigns.map((c) => c.campaignId),
    ...diff.newReportDates.map((c) => c.campaignId),
    ...diff.passedNextReportDate.map((c) => c.campaignId),
  ];
  const [clientByCampaign, lastAppliedByCampaign] = await Promise.all([
    resolveClientIdForCampaign(allCampaignIds),
    lastAppliedAtForCampaign(allCampaignIds),
  ]);

  async function gatedEnqueue(
    campaignId: string,
    enqueueFn: () => Promise<void>,
  ): Promise<void> {
    // `new_campaign` candidates are never gated on staleness — they
    // have never been refreshed — but they ARE gated on active-client
    // and queue pause. Pass `lastRefreshedAt=null` so the gate falls
    // through the staleness check.
    const meta = getCachedKeywordInventoryMeta(campaignId);
    const lastRefreshedAt = meta && meta.complete === false
      ? null
      : (lastAppliedByCampaign.get(campaignId) ?? null);
    const gate = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId,
      clientId: clientByCampaign.get(campaignId) ?? null,
      lastRefreshedAt,
    });
    if (!gate.allow) return;
    await enqueueFn();
    enqueued++;
  }

  for (const newCampaign of diff.newCampaigns) {
    if (newCampaign.reportDates.length === 0) continue;
    await gatedEnqueue(newCampaign.campaignId, () =>
      enqueueJob({
        queueName: "semrush_report_refresh",
        workloadClass: "ingestion",
        priority: 3,
        payload: {
          campaignId: newCampaign.campaignId,
          businessName: newCampaign.businessName,
          trigger: "new_campaign",
          reportDate: newCampaign.lastReportDate,
        },
        dedupeKey: `semrush:refresh:${newCampaign.campaignId}:new_campaign`,
      }).then(() => undefined),
    );
  }

  for (const item of diff.newReportDates) {
    const latestNewDate = item.newDates.sort(
      (a, b) => new Date(b).getTime() - new Date(a).getTime(),
    )[0];
    await gatedEnqueue(item.campaignId, () =>
      enqueueJob({
        queueName: "semrush_report_refresh",
        workloadClass: "ingestion",
        priority: 4,
        payload: {
          campaignId: item.campaignId,
          businessName: item.businessName,
          trigger: "new_report_date",
          reportDate: latestNewDate,
          newDates: item.newDates,
        },
        dedupeKey: `semrush:refresh:${item.campaignId}:report:${latestNewDate}`,
      }).then(() => undefined),
    );
  }

  for (const item of diff.passedNextReportDate) {
    const triggerKey = `${item.campaignId}:${item.nextReportDate}`;
    triggeredNextReportDates.add(triggerKey);
    await gatedEnqueue(item.campaignId, () =>
      enqueueJob({
        queueName: "semrush_report_refresh",
        workloadClass: "ingestion",
        priority: 5,
        payload: {
          campaignId: item.campaignId,
          businessName: item.businessName,
          trigger: "next_report_date_passed",
          nextReportDate: item.nextReportDate,
        },
        dedupeKey: `semrush:refresh:${item.campaignId}:passed:${item.nextReportDate}`,
      }).then(() => undefined),
    );
  }

  return enqueued;
}

export async function runInventorySync(): Promise<{
  campaignCount: number;
  diff: InventoryDiff;
  eventId: string;
  enqueuedRefreshJobs: number;
}> {
  const { workerLog } = await import("./workerLogger");
  const startTime = Date.now();

  try {
    await restoreInventoryFromDb();
    const inventory = await fetchInventory();
    const diff = diffInventory(previousInventory, inventory);
    const eventId = await persistInventoryEvent(inventory, diff);
    const enqueuedRefreshJobs = await enqueueRefreshWork(diff);

    previousInventory = inventory;

    const summary = {
      campaignCount: inventory.campaigns.length,
      newCampaigns: diff.newCampaigns.length,
      removedCampaigns: diff.removedCampaignIds.length,
      newReportDates: diff.newReportDates.length,
      passedNextReportDate: diff.passedNextReportDate.length,
      enqueuedRefreshJobs,
    };

    console.log(
      `[${WORKER_NAME}] Inventory sync complete: ${JSON.stringify(summary)}`,
    );
    workerLog({
      worker: WORKER_NAME,
      event: "worker_completed",
      durationMs: Date.now() - startTime,
      itemsProcessed: inventory.campaigns.length,
    });

    return {
      campaignCount: inventory.campaigns.length,
      diff,
      eventId,
      enqueuedRefreshJobs,
    };
  } catch (err: any) {
    workerLog({
      worker: WORKER_NAME,
      event: "worker_failed",
      durationMs: Date.now() - startTime,
      error: err?.message,
    });
    throw err;
  }
}

export async function triggerReportRefresh(
  campaignId: string,
  trigger: "manual" | "monthly_report",
  reportDate?: string,
): Promise<string> {
  if (!PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
    throw new Error("Semrush report-driven refresh is disabled");
  }

  // Task #1784: pause guard at the enqueue site. The `monthly_report`
  // trigger is background-driven and must respect the pause. The
  // `manual` trigger is an explicit operator override (Operations
  // Console "Refresh now" button) and is allowed through so a paused
  // queue does not block a one-off forced probe — the runbook in
  // SEMRUSH_CADENCE.md documents this escape hatch.
  if (trigger !== "manual") {
    // Task #1785: demand-driven gate. `monthly_report` is a scheduled,
    // tenant-wide trigger — gate it on the master switch + queue pause.
    // Per-campaign staleness is enforced downstream when the inventory
    // sync diff produces a per-campaign refresh enqueue.
    const { evaluateRefreshGate, resolveClientIdForCampaign, lastAppliedAtForCampaign } =
      await import("./semrushCadenceGate");
    const { getCachedKeywordInventoryMeta } = await import("./semrushApi");
    // Task #1785 review-remediation: resolve the owning client + last
    // applied timestamp so the monthly_report gate runs both the
    // staleness AND active-client checks (not staleness alone).
    const [clientMap, appliedMap] = await Promise.all([
      resolveClientIdForCampaign([campaignId]),
      lastAppliedAtForCampaign([campaignId]),
    ]);
    // Task #1973: incomplete cached inventory ⇒ treat as stale at the gate.
    const monthlyMeta = getCachedKeywordInventoryMeta(campaignId);
    const monthlyLastRefreshedAt = monthlyMeta && monthlyMeta.complete === false
      ? null
      : (appliedMap.get(campaignId) ?? null);
    const gate = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId,
      clientId: clientMap.get(campaignId) ?? null,
      lastRefreshedAt: monthlyLastRefreshedAt,
    });
    if (!gate.allow) {
      throw new Error(
        `Semrush report refresh skipped by demand-driven gate (${gate.reason}). Use trigger=manual to override.`,
      );
    }
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("semrush_report_refresh")) {
      try {
        const { workerLog } = await import("./workerLogger");
        workerLog({
          worker: "semrush_report_refresh",
          event: "semrush_refresh_enqueue_skipped_queue_paused",
          workloadClass: "ingestion",
          reason: `triggerReportRefresh:${trigger}`,
          campaignId,
        });
      } catch {}
      throw new Error(
        "Semrush report refresh queue is paused (Task #1784). Resume via Queue Drain UI or trigger=manual.",
      );
    }
  }

  const { enqueueJob } = await import("./workScheduler");

  const dedupeKey = `semrush:refresh:${campaignId}:${trigger}:${reportDate || "latest"}`;
  const jobId = await enqueueJob({
    queueName: "semrush_report_refresh",
    workloadClass: trigger === "manual" ? "interactive" : "ingestion",
    priority: trigger === "manual" ? 1 : 4,
    payload: {
      campaignId,
      trigger,
      reportDate: reportDate || null,
    },
    dedupeKey,
  });

  const eventDedupeKey = `semrush:refresh_request:${campaignId}:${trigger}:${reportDate || "latest"}:${Date.now()}`;
  await db.insert(sourceEventLog).values({
    sourceSystem: "semrush",
    sourceEventType: "refresh_request",
    sourceObjectId: `campaign:${campaignId}`,
    dedupeKey: eventDedupeKey,
    payloadJson: {
      campaignId,
      trigger,
      reportDate: reportDate || null,
      workQueueJobId: jobId,
    },
    status: "received",
  });

  console.log(
    `[${WORKER_NAME}] Refresh request enqueued: campaign=${campaignId} trigger=${trigger} jobId=${jobId}`,
  );
  return jobId;
}

export interface HandleRefreshJobDeps {
  semrushApi?: {
    getCampaign: (campaignId: string) => Promise<any>;
    getCampaignKeywords: (campaignId: string) => Promise<any[]>;
    getHeatmapData: (campaignId: string, kwId: string, opts: any) => Promise<any>;
  };
  enqueueJob?: (params: {
    queueName: string;
    workloadClass: string;
    priority: number;
    payload: any;
    dedupeKey?: string;
    // Task #953: deferred re-enqueue support so a refresh skipped by the
    // upstream circuit breaker can be re-scheduled past the cooldown.
    retryAt?: Date;
  }) => Promise<any>;
}

export async function handleRefreshJob(
  job: { payload: any },
  deps?: HandleRefreshJobDeps,
): Promise<void> {
  const { campaignId, trigger, reportDate, businessName } =
    job.payload || {};
  if (!campaignId) {
    throw new Error("Missing campaignId in refresh job payload");
  }

  const semrushApi = deps?.semrushApi || (await import("./semrushApi"));
  const { getCampaign, getCampaignKeywords, getHeatmapData } = semrushApi;
  const enqueueJob =
    deps?.enqueueJob || (await import("./workScheduler")).enqueueJob;

  // Task #953: gate background-triggered refreshes on the SEMrush circuit
  // breaker so that a collapsed upstream stops continuously re-failing
  // into the ingestion class. ONLY the explicit operator-initiated
  // `manual` trigger bypasses the open state as a forced probe;
  // `monthly_report` and `inventory_sweep` are background ingestion-class
  // work and must respect the breaker so they don't keep consuming
  // ingestion capacity during a collapse. Deferred jobs are re-enqueued
  // below with `retryAt` past the cooldown so forward progress is
  // preserved without burning maxAttempts on the current job.
  const isManualTrigger = trigger === "manual";
  const breakerMod = await import("./semrushCircuitBreaker");
  const decision = breakerMod.shouldAllowRequest({
    isManual: isManualTrigger,
    campaignId,
    caller: "report_refresh",
  });
  if (!decision.allowed) {
    // Task #953 (review fix): preserve forward progress. Returning here
    // marks the current job completed from the scheduler's perspective,
    // so we re-enqueue a deferred copy with `retryAt` set past the
    // breaker cooldown. Dedupe key is bucketed by cooldown window so
    // concurrent defers (e.g. an enrichment + a manual sweep landing in
    // the same minute) collapse to a single deferred row per
    // (campaign, trigger, reportDate, bucket) instead of fanning out.
    const cooldownMs = Math.max(PERF.SEMRUSH_BREAKER_COOLDOWN_MS, 60_000);
    const retryDelayMs = Math.max(decision.retryAfterMs ?? cooldownMs, 30_000);
    const retryAt = new Date(Date.now() + retryDelayMs);
    const bucket = Math.floor(retryAt.getTime() / cooldownMs);
    const deferredDedupeKey = `semrush:refresh:${campaignId}:${trigger}:${reportDate || "latest"}:deferred:${bucket}`;
    // Task #1784: do not re-enqueue a breaker-deferred copy while the
    // queue is paused. The current job is already returning successfully
    // (forward progress preserved); re-emitting a deferred row would
    // grow the pending pile during the pause window.
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("semrush_report_refresh")) {
      try {
        const { workerLog } = await import("./workerLogger");
        workerLog({
          worker: "semrush_report_refresh",
          event: "semrush_refresh_enqueue_skipped_queue_paused",
          workloadClass: "ingestion",
          reason: "breaker_deferred_reenqueue",
          campaignId,
        });
      } catch {}
      return;
    }
    try {
      await enqueueJob({
        queueName: "semrush_report_refresh",
        workloadClass: "ingestion",
        priority: 5,
        payload: {
          campaignId,
          trigger,
          reportDate: reportDate || null,
          businessName,
        },
        retryAt,
        dedupeKey: deferredDedupeKey,
      });
    } catch (reEnqErr: any) {
      console.warn(
        `[${WORKER_NAME}] Failed to re-enqueue deferred refresh (campaign=${campaignId}): ${reEnqErr?.message}`,
      );
    }
    console.warn(
      `[${WORKER_NAME}] Refresh deferred — ${decision.reason} (campaign=${campaignId} trigger=${trigger} state=${decision.state} retryAfterMs=${decision.retryAfterMs ?? "?"} reEnqueuedAt=${retryAt.toISOString()})`,
    );
    try {
      const { workerLog } = await import("./workerLogger");
      const jobId = (job as { id?: string }).id;
      workerLog({
        worker: WORKER_NAME,
        event: "refresh_deferred_breaker",
        jobId,
        campaignId,
        trigger,
        breakerState: decision.state,
        deferReason: decision.reason,
        retryAtMs: retryAt.getTime(),
      });
    } catch {}
    return;
  }

  console.log(
    `[${WORKER_NAME}] Processing refresh: campaign=${campaignId} trigger=${trigger}`,
  );

  let campaign: any;
  let keywords: any[];
  try {
    campaign = await getCampaign(campaignId);
    keywords = await getCampaignKeywords(campaignId);
  } catch (err: any) {
    // Task #953: per-campaign backoff. The underlying API failure has
    // already been counted by `apiGet`'s breaker hook, so we only tag
    // the campaign-backoff map here (no second sample push). This
    // prevents the same upstream failure from double-incrementing the
    // breaker's failure window. Rethrow so the work scheduler still
    // applies its bounded retry (maxAttempts / exponential backoff)
    // for transient blips.
    breakerMod.markCampaignBackoff(campaignId);
    throw err;
  }
  const activeKeywords = keywords.filter(
    (kw) =>
      kw.status === "COLLECTED" ||
      kw.status === "UNKNOWN" ||
      kw.status === "ACTIVE",
  );

  if (activeKeywords.length === 0) {
    console.warn(
      `[${WORKER_NAME}] No active keywords for campaign ${campaignId}, skipping refresh`,
    );
    return;
  }

  let selectedReportDate: string | null = reportDate || null;
  if (!selectedReportDate && campaign.reportDates?.length) {
    selectedReportDate = campaign.reportDates[0];
  }
  if (!selectedReportDate) {
    console.warn(
      `[${WORKER_NAME}] No report date available for campaign ${campaignId}, skipping`,
    );
    return;
  }

  const grid = campaign.gridSettings || campaign.grid || {};
  const campaignCid = campaign.business?.cid || campaign.cid;
  const campaignPlaceIds =
    campaign.business?.placeIds || campaign.placeIds;

  const eventDedupeKey = `semrush:refresh_result:${campaignId}:${selectedReportDate}:${Date.now()}`;
  const [event] = await db
    .insert(sourceEventLog)
    .values({
      sourceSystem: "semrush",
      sourceEventType: "report_refresh",
      sourceObjectId: `campaign:${campaignId}:report:${selectedReportDate}`,
      dedupeKey: eventDedupeKey,
      payloadJson: {
        campaignId,
        trigger,
        reportDate: selectedReportDate,
        keywordCount: activeKeywords.length,
      },
      status: "received",
      expectedResultCount: activeKeywords.length,
    })
    .returning({ id: sourceEventLog.id });

  let fetchedCount = 0;
  let enqueuedApplyCount = 0;
  const errors: string[] = [];

  // Canonical location-aware resolution: a campaign refresh must produce one
  // heatmap snapshot per (clientId, locationId) pair that is mapped to this
  // SEMrush campaign in `semrush_location_campaigns`. The legacy single-
  // integration lookup (which used `clientSemrushIntegrations.semrushCampaignId`
  // + `businessLocationId`) silently dropped non-primary locations of multi-
  // location clients, causing the dashboard to report "keyword not tracked"
  // for every location after the first.
  const locationMappings = await db
    .select({
      clientId: semrushLocationCampaigns.clientId,
      locationId: semrushLocationCampaigns.locationId,
      campaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns)
    .where(
      and(
        eq(semrushLocationCampaigns.semrushCampaignId, campaignId),
        eq(semrushLocationCampaigns.isStale, false),
      ),
    );

  type RefreshTarget = {
    clientId: string | undefined;
    locationId: string;
    locationName: string;
  };

  const refreshTargets: RefreshTarget[] = [];

  if (locationMappings.length > 0) {
    for (const m of locationMappings) {
      refreshTargets.push({
        clientId: m.clientId,
        locationId: m.locationId,
        locationName:
          m.campaignName ||
          businessName ||
          campaign.businessName ||
          "Unknown",
      });
    }
  } else {
    // Legacy fallback: clients that haven't been migrated to the per-location
    // mapping table still configure a single campaign on the integration row.
    const legacyIntegrations = await db
      .select()
      .from(clientSemrushIntegrations)
      .where(
        and(
          eq(clientSemrushIntegrations.isActive, true),
          sql`${clientSemrushIntegrations.semrushCampaignId} = ${campaignId}`,
        ),
      );
    if (legacyIntegrations.length === 0) {
      refreshTargets.push({
        clientId: undefined,
        locationId: `campaign-${campaignId}`,
        locationName: businessName || campaign.businessName || "Unknown",
      });
    } else {
      for (const integ of legacyIntegrations) {
        refreshTargets.push({
          clientId: integ.clientId,
          locationId:
            integ.businessLocationId || `campaign-${campaignId}`,
          locationName:
            businessName || campaign.businessName || "Unknown",
        });
      }
    }
  }

  console.log(
    `[${WORKER_NAME}] Refresh campaign=${campaignId} resolved to ${refreshTargets.length} (clientId, locationId) target(s): ${JSON.stringify(refreshTargets.map((t) => ({ c: t.clientId, l: t.locationId })))}`,
  );

  for (const kw of activeKeywords) {
    try {
      const opts: {
        cid?: string;
        placeIds?: string[];
        reportDate?: string;
      } = {};
      if (campaignCid) opts.cid = campaignCid;
      if (campaignPlaceIds?.length) opts.placeIds = campaignPlaceIds;
      if (selectedReportDate) opts.reportDate = selectedReportDate;

      const heatmapResult = await getHeatmapData(
        campaignId,
        kw.id,
        opts,
      );

      // Emit one apply job per mapped (clientId, locationId) target so each
      // location's row in heatmap_snapshots is written under its own identity
      // and is no longer cleaned up as orphaned by the local-dominance worker.
      for (const target of refreshTargets) {
        const heatmapPayload = {
          clientId: target.clientId,
          locationId: target.locationId,
          locationName: target.locationName,
          businessName:
            target.locationName ||
            businessName ||
            campaign.businessName,
          campaignId,
          keywordId: kw.id,
          keywordName: heatmapResult.keyword.name || kw.name,
          reportDate: heatmapResult.date,
          businessLat: grid.basePoint?.lat || campaign.lat || 0,
          businessLng: grid.basePoint?.lng || campaign.lng || 0,
          gridTemplate: grid.template || "9x9",
          gridUnit: grid.unit || "MILES",
          gridDistance: grid.distance || 5,
          baseLat: grid.basePoint?.lat || campaign.lat || 0,
          baseLng: grid.basePoint?.lng || campaign.lng || 0,
          pointsNumber: heatmapResult.positions.length,
          points: heatmapResult.positions.map((p: any) => ({
            id: p.point.id,
            lat: p.point.lat,
            lng: p.point.lng,
            position: p.rank,
            diff: p.diff,
          })),
          cid: campaignCid,
          placeIds: campaignPlaceIds,
          campaignReportDates: campaign.reportDates || [],
        };

        // Task #1785: identical-result apply suppression. Hash the
        // refresh payload; if it matches what we last applied for this
        // (campaign, location, snapshot) tuple, skip the apply enqueue
        // entirely. This is the dominant savings: most refreshes return
        // the same numbers as the prior one. Hash check is gated by the
        // `semrush_identical_result_apply_suppression` switch.
        const { hashSemrushResponse, shouldSuppressApply } = await import("./semrushCadenceGate");
        const responseHash = hashSemrushResponse(heatmapPayload);
        const suppress = await shouldSuppressApply({
          key: {
            campaignId,
            locationId: target.locationId,
            snapshotKey: `${kw.id}:${selectedReportDate}`,
          },
          freshHash: responseHash,
          queueName: "semrush_heatmap_apply",
        });

        const [workResult] = await db
          .insert(workResultLog)
          .values({
            sourceEventId: event.id,
            sourceSystem: "semrush",
            resultType: "semrush_heatmap_refresh",
            resultJson: { ...heatmapPayload, __responseHash: responseHash },
            status: suppress ? "skipped" : "completed",
            correlationId: `${campaignId}:${target.locationId}:${kw.id}:${selectedReportDate}`,
          })
          .returning({ id: workResultLog.id });

        if (!suppress) {
          await enqueueJob({
            queueName: "semrush_heatmap_apply",
            workloadClass: "ingestion",
            priority: 4,
            payload: { workResultId: workResult.id },
            dedupeKey: `semrush:heatmap_apply:${workResult.id}`,
          });
          enqueuedApplyCount++;
        }
      }

      fetchedCount++;
    } catch (kwErr: any) {
      errors.push(`"${kw.name}": ${kwErr?.message || String(kwErr)}`);
      console.error(
        `[${WORKER_NAME}] Refresh fetch failed for keyword "${kw.name}" (${kw.id}): ${kwErr?.message}`,
      );
    }
  }

  const allFailed = errors.length === activeKeywords.length;
  await db
    .update(sourceEventLog)
    .set({
      status: allFailed
        ? "failed"
        : fetchedCount > 0
          ? "ready_to_apply"
          : "failed",
      expectedResultCount: fetchedCount,
      resultsFinalizedAt: new Date(),
      errorMessage: allFailed
        ? `All ${activeKeywords.length} keywords failed to fetch`
        : errors.length > 0
          ? `${errors.length}/${activeKeywords.length} keywords failed to fetch`
          : undefined,
      updatedAt: new Date(),
    })
    .where(eq(sourceEventLog.id, event.id));

  console.log(
    `[${WORKER_NAME}] Refresh fetch complete: campaign=${campaignId} fetched=${fetchedCount}/${activeKeywords.length} applyJobsEnqueued=${enqueuedApplyCount} errors=${errors.length}`,
  );
}

export function startInventorySyncScheduler(): void {
  if (!PERF.SEMRUSH_INVENTORY_SYNC_ENABLED) {
    console.log(
      `[${WORKER_NAME}] Inventory sync disabled (SEMRUSH_INVENTORY_SYNC_ENABLED=false)`,
    );
    return;
  }

  if (inventoryTimer) return;

  const intervalMs = PERF.SEMRUSH_INVENTORY_SYNC_INTERVAL_MS;
  console.log(
    `[${WORKER_NAME}] Starting inventory sync scheduler (every ${(intervalMs / 3600000).toFixed(1)}h)`,
  );

  inventoryTimer = setInterval(() => {
    void withDbAttribution("worker:semrush-inventory-sync", async () => {
    if (isSyncing) {
      console.log(`[${WORKER_NAME}] Skipping — sync already in progress`);
      return;
    }

    // Task #2363 — cluster-wide single-flight. On `autoscale` this
    // interval fires on every instance; the advisory lock makes exactly
    // one instance run the sweep. The work it enqueues is dedupe-keyed in
    // `work_queue` (UNIQUE wq_dedupe_key_idx) so duplicate enqueues are
    // already harmless, but locking the sweep avoids redundant SEMrush
    // paging/enrichment passes.
    // Task #2383 — bound the hold so a hung sweep (e.g. a stalled SEMrush
    // paging/enrichment call) can't keep the cluster-wide lock forever.
    const { acquireDistributedLock } = await import("./workerLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("./workerConfig");
    const lock = await acquireDistributedLock(
      WORKER_NAME,
      undefined,
      undefined,
      CROSS_INSTANCE_LOCK_MAX_HOLD_MS.semrush_inventory_sync,
    );
    if (!lock) {
      console.log(`[${WORKER_NAME}] Skipping — could not acquire worker lock`);
      return;
    }

    isSyncing = true;
    try {
      await runInventorySync();
    } catch (err: any) {
      console.error(
        `[${WORKER_NAME}] Scheduled inventory sync failed:`,
        err?.message,
      );
    } finally {
      isSyncing = false;
      await lock.release();
    }
    });
  }, intervalMs);
}

export function stopInventorySyncScheduler(): void {
  if (inventoryTimer) {
    clearInterval(inventoryTimer);
    inventoryTimer = null;
    console.log(`[${WORKER_NAME}] Inventory sync scheduler stopped`);
  }
}

/**
 * Task #978 Phase 1: handler registration moved to
 * `registerAllHandlers()` in workQueueHandlers.ts so it is registered
 * synchronously during bootstrap (before the scheduler begins polling).
 * Previously this deferred registration caused every restart to fail
 * pending `semrush_report_refresh` jobs with "No handler registered"
 * because the scheduler started polling earlier than this tick fired.
 *
 * Kept as an exported no-op for back-compat with any callers/tests that
 * may still invoke it. Safe to remove once those references are cleaned
 * up.
 *
 * @deprecated Registration is performed by `registerAllHandlers()`.
 */
export function registerRefreshHandler(): void {
  // Intentionally empty — registration happens synchronously elsewhere.
}

export async function onMonthlyReportGenerated(
  clientId: string,
  reportMonth: string,
): Promise<{ triggered: boolean; jobIds: string[] }> {
  if (!PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
    return { triggered: false, jobIds: [] };
  }

  try {
    const integrations = await db
      .select()
      .from(clientSemrushIntegrations)
      .where(
        and(
          eq(clientSemrushIntegrations.clientId, clientId),
          eq(clientSemrushIntegrations.isActive, true),
          eq(clientSemrushIntegrations.integrationEnabled, true),
        ),
      )
      .limit(1);

    if (!integrations[0]?.semrushCampaignId) {
      return { triggered: false, jobIds: [] };
    }

    const campaignId = integrations[0].semrushCampaignId;
    const { getCampaign, findBestReportDate } = await import("./semrushApi");
    const campaign = await getCampaign(campaignId);

    let reportDate: string | undefined;
    if (campaign.reportDates?.length && reportMonth) {
      reportDate =
        findBestReportDate(campaign.reportDates, reportMonth) || undefined;
    }

    const jobId = await triggerReportRefresh(
      campaignId,
      "monthly_report",
      reportDate,
    );
    console.log(
      `[${WORKER_NAME}] Monthly report refresh triggered for client=${clientId} campaign=${campaignId} month=${reportMonth} jobId=${jobId}`,
    );
    return { triggered: true, jobIds: [jobId] };
  } catch (err: any) {
    console.error(
      `[${WORKER_NAME}] Monthly report refresh failed for client=${clientId}: ${err?.message}`,
    );
    return { triggered: false, jobIds: [] };
  }
}

export interface BackfillOptions {
  clientIds?: string[];
  locationIds?: string[];
  campaignIds?: string[];
  sinceDate?: string;
  untilDate?: string;
  dryRun?: boolean;
}

export interface BackfillResult {
  dryRun: boolean;
  jobId?: string | null;
  mappings: Array<{
    clientId: string;
    locationId: string;
    semrushCampaignId: string;
    semrushCampaignName: string | null;
  }>;
  campaignsConsidered: number;
  campaignsFetched: number;
  campaignFetchFailures: Array<{ campaignId: string; error: string }>;
  reportDatesEnqueued: Array<{
    campaignId: string;
    reportDate: string;
    jobId: string | null;
  }>;
  reportDatesSkipped: Array<{
    campaignId: string;
    reportDate: string;
    reason: string;
  }>;
  enqueuedJobCount: number;
}

/**
 * One-shot backfill that re-runs the SEMrush refresh for every
 * (clientId, locationId, campaignId) mapping in `semrush_location_campaigns`
 * across the campaign's known report dates (filtered by the optional
 * since/until window). Each enqueued refresh job will, via
 * `handleRefreshJob`, write one heatmap snapshot per mapped location for the
 * target report date — restoring historical heatmaps for multi-location
 * clients whose non-primary locations were previously dropped or pruned.
 *
 * The work is deduped per (campaignId, reportDate) so a single refresh job
 * fans out to every location attached to that campaign rather than enqueuing
 * one job per location.
 */
export async function backfillLocationHeatmaps(
  opts: BackfillOptions & { triggeredBy?: string | null } = {},
): Promise<BackfillResult> {
  const dryRun = !!opts.dryRun;

  // Validate ALL preconditions BEFORE creating a job row, so we never leave a
  // job stuck in "running" because of a guard-check throw.
  if (!dryRun && !PERF.SEMRUSH_REPORT_REFRESH_ENABLED) {
    throw new Error(
      "Cannot run backfill: SEMRUSH_REPORT_REFRESH_ENABLED is false. Enable it first or run with dryRun=true.",
    );
  }
  const sinceMs = opts.sinceDate ? new Date(opts.sinceDate).getTime() : null;
  const untilMs = opts.untilDate ? new Date(opts.untilDate).getTime() : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid sinceDate: ${opts.sinceDate}`);
  }
  if (untilMs !== null && Number.isNaN(untilMs)) {
    throw new Error(`Invalid untilDate: ${opts.untilDate}`);
  }

  // Canonical backfill job row — written for live (non-dryRun) runs only.
  // Dry runs are pure previews and don't deserve a persistent job audit row.
  let jobId: string | null = null;
  let backfillJobsMod: typeof import("./backfillJobs") | null = null;
  if (!dryRun) {
    try {
      backfillJobsMod = await import("./backfillJobs");
      const job = await backfillJobsMod.createBackfillJob({
        jobType: "semrush_heatmap_backfill",
        triggeredBy: opts.triggeredBy ?? null,
        parameters: {
          clientIds: opts.clientIds ?? null,
          locationIds: opts.locationIds ?? null,
          campaignIds: opts.campaignIds ?? null,
          sinceDate: opts.sinceDate ?? null,
          untilDate: opts.untilDate ?? null,
        },
      });
      jobId = job.id;
      await backfillJobsMod.markJobRunning(jobId);
    } catch (e: any) {
      console.warn(`[${WORKER_NAME}] Backfill: failed to record backfill job (non-fatal): ${e?.message || e}`);
      backfillJobsMod = null;
      jobId = null;
    }
  }

  // Task #726: auto-mute manual-reserve alerts for the duration of this
  // backfill run. The clear in `finally` removes it on completion; the 4h
  // safety cap (capped further to MAX_MUTE_DURATION_MS=7d in the helper)
  // means a crashed worker still naturally expires the mute. Manual mutes
  // installed by an operator take precedence and are not overwritten.
  if (!dryRun && jobId) {
    try {
      const { setManualReserveMuteForBackfillJob } = await import(
        "./manualReserveAlerts"
      );
      const outcome = await setManualReserveMuteForBackfillJob({
        jobId,
        jobLabel: WORKER_NAME,
        durationMs: 4 * 60 * 60_000,
        reason: `Auto-muted for ${WORKER_NAME} backfill (job ${jobId})`,
      });
      if (!outcome.applied) {
        console.log(
          `[${WORKER_NAME}] Backfill: skipped auto-mute (operator manual mute is active)`,
        );
      }
    } catch (e: any) {
      console.warn(
        `[${WORKER_NAME}] Backfill: failed to auto-mute manual-reserve alerts (non-fatal): ${e?.message || e}`,
      );
    }
  }

  const conditions = [eq(semrushLocationCampaigns.isStale, false)];
  if (opts.clientIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.clientId} IN (${sql.join(
        opts.clientIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  if (opts.locationIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.locationId} IN (${sql.join(
        opts.locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  if (opts.campaignIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.semrushCampaignId} IN (${sql.join(
        opts.campaignIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }

  const mappings = await db
    .select({
      clientId: semrushLocationCampaigns.clientId,
      locationId: semrushLocationCampaigns.locationId,
      semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
      semrushCampaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns)
    .where(and(...conditions));

  const result: BackfillResult = {
    dryRun,
    jobId,
    mappings,
    campaignsConsidered: 0,
    campaignsFetched: 0,
    campaignFetchFailures: [],
    reportDatesEnqueued: [],
    reportDatesSkipped: [],
    enqueuedJobCount: 0,
  };

  // Track which (campaignId, reportDate) tuples were enqueue failures (vs
  // legitimately filtered out by date / no-data). This drives both the
  // failed-units counter and the auto coverage-gap scope.
  const enqueueFailureCount = { n: 0 };
  // (campaignId -> { keywords, reportDates }) — populated alongside the
  // enqueue loop so the post-run coverage check doesn't pay another round of
  // SEMrush API calls.
  const expectedByCampaign = new Map<string, { reportDates: string[]; keywords: string[] }>();

  let fatalError: Error | null = null;

  try {
    const uniqueCampaignIds = Array.from(
      new Set(mappings.map((m) => m.semrushCampaignId)),
    );
    result.campaignsConsidered = uniqueCampaignIds.length;

    if (uniqueCampaignIds.length === 0) {
      console.log(
        `[${WORKER_NAME}] Backfill: no mappings matched filters, nothing to do`,
      );
      return result;
    }

    const { getCampaign, getCampaignKeywordsWithMeta } = await import("./semrushApi");

    for (const campaignId of uniqueCampaignIds) {
      let campaign: any;
      try {
        campaign = await getCampaign(campaignId);
        result.campaignsFetched++;
      } catch (err: any) {
        const message = err?.message || String(err);
        console.warn(
          `[${WORKER_NAME}] Backfill: failed to fetch campaign ${campaignId}: ${message}`,
        );
        result.campaignFetchFailures.push({ campaignId, error: message });
        continue;
      }

      const reportDates: string[] = Array.isArray(campaign?.reportDates)
        ? campaign.reportDates
        : [];

      // Capture expected keywords once per campaign for the coverage check.
      // Only matters for live runs that will actually finalize the job.
      if (!dryRun) {
        try {
          const { keywords } = await getCampaignKeywordsWithMeta(campaignId);
          expectedByCampaign.set(campaignId, {
            reportDates,
            keywords: keywords.map((k) => k.name),
          });
        } catch (err: any) {
          console.warn(
            `[${WORKER_NAME}] Backfill: failed to fetch keywords for coverage check campaign=${campaignId}: ${err?.message || err}`,
          );
        }
      }

      if (reportDates.length === 0) {
        result.reportDatesSkipped.push({
          campaignId,
          reportDate: "*",
          reason: "campaign has no report dates",
        });
        continue;
      }

      for (const reportDate of reportDates) {
        const ts = new Date(reportDate).getTime();
        if (Number.isNaN(ts)) {
          result.reportDatesSkipped.push({
            campaignId,
            reportDate,
            reason: "unparseable report date",
          });
          continue;
        }
        if (sinceMs !== null && ts < sinceMs) {
          result.reportDatesSkipped.push({
            campaignId,
            reportDate,
            reason: "before sinceDate",
          });
          continue;
        }
        if (untilMs !== null && ts > untilMs) {
          result.reportDatesSkipped.push({
            campaignId,
            reportDate,
            reason: "after untilDate",
          });
          continue;
        }

        if (dryRun) {
          result.reportDatesEnqueued.push({
            campaignId,
            reportDate,
            jobId: null,
          });
          continue;
        }

        try {
          const refreshJobId = await triggerReportRefresh(
            campaignId,
            "manual",
            reportDate,
          );
          result.reportDatesEnqueued.push({ campaignId, reportDate, jobId: refreshJobId });
          result.enqueuedJobCount++;
          // Live progress: bump processed+succeeded on the canonical job row
          // so an operator polling the API can watch the counters move while
          // a long backfill is still in flight.
          if (jobId && backfillJobsMod) {
            backfillJobsMod.recordProgress(jobId, { processed: 1, succeeded: 1 }).catch(() => {});
          }
        } catch (err: any) {
          const message = err?.message || String(err);
          console.warn(
            `[${WORKER_NAME}] Backfill: failed to enqueue refresh for campaign=${campaignId} reportDate=${reportDate}: ${message}`,
          );
          // Enqueue failure → counts as a real failed unit, not a skip.
          enqueueFailureCount.n++;
          result.reportDatesSkipped.push({
            campaignId,
            reportDate,
            reason: `enqueue failed: ${message}`,
          });
          if (jobId && backfillJobsMod) {
            backfillJobsMod.recordProgress(jobId, { processed: 1, failed: 1 }).catch(() => {});
          }
        }
      }
    }

    console.log(
      `[${WORKER_NAME}] Backfill complete: dryRun=${dryRun} mappings=${mappings.length} campaigns=${result.campaignsFetched}/${result.campaignsConsidered} enqueued=${result.enqueuedJobCount} skipped=${result.reportDatesSkipped.length} enqueueFailures=${enqueueFailureCount.n}`,
    );

    return result;
  } catch (err: any) {
    fatalError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    // ALWAYS write a terminal status for any job we created. Even if the
    // function throws, we don't want to leave a job stuck in "running".
    if (jobId && backfillJobsMod) {
      try {
        const failedUnits = result.campaignFetchFailures.length + enqueueFailureCount.n;
        // Live progress was incremented per enqueue in the loop. Add only
        // the campaign-level failures here (which weren't counted there).
        if (result.campaignFetchFailures.length > 0) {
          await backfillJobsMod.recordProgress(jobId, {
            failed: result.campaignFetchFailures.length,
          });
        }

        let coverageGaps: import("./backfillJobs").CoverageGap[] | null = null;
        if (!fatalError) {
          // Auto-compute coverage gaps using the SEMrush metadata we already
          // gathered above. We're checking which expected snapshots are
          // present RIGHT NOW; the enqueued refresh jobs will fill in the
          // rest asynchronously and a re-check via the GET endpoint will
          // show shrinking gaps.
          try {
            const scope: import("./backfillJobs").CoverageScopeUnit[] = [];
            for (const m of mappings) {
              const exp = expectedByCampaign.get(m.semrushCampaignId);
              if (!exp || exp.keywords.length === 0) continue;
              for (const d of exp.reportDates) {
                const ts = new Date(d).getTime();
                if (Number.isNaN(ts)) continue;
                if (sinceMs !== null && ts < sinceMs) continue;
                if (untilMs !== null && ts > untilMs) continue;
                scope.push({
                  clientId: m.clientId,
                  locationId: m.locationId,
                  campaignId: m.semrushCampaignId,
                  reportDate: d.split("T")[0],
                  expectedKeywords: exp.keywords,
                });
              }
            }
            coverageGaps = await backfillJobsMod.computeCoverageGaps(scope);
          } catch (e: any) {
            console.warn(
              `[${WORKER_NAME}] Backfill: coverage-gap computation failed (non-fatal): ${e?.message || e}`,
            );
          }
        }

        let status: import("./backfillJobs").CompleteJobInput["status"];
        if (fatalError) {
          status = "failed";
        } else if (failedUnits > 0 || (coverageGaps && coverageGaps.length > 0)) {
          status = "partial";
        } else {
          status = "succeeded";
        }
        // Persist the expected scope on the resultJson so the post-drain
        // coverage check (Task #651) can rebuild the same (clientId,
        // locationId, campaignId, reportDate, expectedKeywords) set
        // without re-querying SEMrush.
        //
        // IMPORTANT: scope the persisted reportDates to the dates that
        // were actually enqueued for THIS backfill run (i.e. honor the
        // since/until window the operator passed). `exp.reportDates`
        // came straight from the campaign metadata and is the full
        // history; if we persisted that the post-drain check would
        // evaluate dates the backfill never touched and surface false
        // gaps. We derive the per-campaign date set from
        // `result.reportDatesEnqueued`, which is filtered by since/until
        // and parse-validity at enqueue time.
        const enqueuedDatesByCampaign = new Map<string, Set<string>>();
        for (const e of result.reportDatesEnqueued) {
          let s = enqueuedDatesByCampaign.get(e.campaignId);
          if (!s) {
            s = new Set<string>();
            enqueuedDatesByCampaign.set(e.campaignId, s);
          }
          s.add(e.reportDate);
        }
        const expectedScopeByCampaign: Record<
          string,
          { reportDates: string[]; keywords: string[] }
        > = {};
        for (const [cid, exp] of expectedByCampaign) {
          const enq = enqueuedDatesByCampaign.get(cid);
          if (!enq || enq.size === 0) continue;
          expectedScopeByCampaign[cid] = {
            reportDates: Array.from(enq),
            keywords: exp.keywords,
          };
        }
        const enrichedResult = {
          ...result,
          expectedScopeByCampaign,
        };

        await backfillJobsMod.completeBackfillJob(jobId, {
          status,
          resultJson: enrichedResult,
          errorMessage: fatalError ? fatalError.message : null,
          coverageGaps,
        });

        // Task #651: schedule the auto coverage check unless the backfill
        // ended in a fatal error (we'd just be re-asking about a run we
        // never finished). The scheduler itself is feature-flag-gated, so
        // operators can disable this without redeploying.
        if (!fatalError) {
          try {
            const { scheduleCoverageCheckForBackfill } = await import(
              "./heatmapCoverageCheck"
            );
            const sched = await scheduleCoverageCheckForBackfill({
              backfillJobId: jobId,
            });
            if (sched.scheduled) {
              console.log(
                `[${WORKER_NAME}] Backfill: scheduled post-drain coverage check ` +
                  `jobId=${sched.jobId} runAt=${sched.runAt?.toISOString()}`,
              );
            } else {
              console.log(
                `[${WORKER_NAME}] Backfill: post-drain coverage check not scheduled (${sched.reason})`,
              );
            }
          } catch (e: any) {
            console.warn(
              `[${WORKER_NAME}] Backfill: failed to schedule post-drain coverage check (non-fatal): ${e?.message || e}`,
            );
          }
        }
      } catch (e: any) {
        console.warn(`[${WORKER_NAME}] Backfill: failed to finalize job row (non-fatal): ${e?.message || e}`);
      }
    }
    // Task #726: release the auto-mute we installed for this run. Only
    // clears if the current mute is still owned by THIS jobId — operator
    // manual overrides and newer backfill owners are left untouched.
    if (jobId) {
      try {
        const { clearManualReserveMuteForBackfillJob } = await import(
          "./manualReserveAlerts"
        );
        await clearManualReserveMuteForBackfillJob(jobId);
      } catch (e: any) {
        console.warn(
          `[${WORKER_NAME}] Backfill: failed to release auto-mute (non-fatal, will expire on its own): ${e?.message || e}`,
        );
      }
    }
  }
}

export function getInventoryState(): {
  previousInventory: InventorySnapshot | null;
  isRunning: boolean;
  flags: {
    inventorySyncEnabled: boolean;
    reportRefreshEnabled: boolean;
  };
} {
  return {
    previousInventory,
    isRunning: isSyncing,
    flags: {
      inventorySyncEnabled: PERF.SEMRUSH_INVENTORY_SYNC_ENABLED,
      reportRefreshEnabled: PERF.SEMRUSH_REPORT_REFRESH_ENABLED,
    },
  };
}
