import { workerDb } from "../db";
import {
  rawCommunicationRecords,
  heatmapSnapshots,
  heatmapPoints,
  heatmapMetrics,
  clientSemrushIntegrations,
  semrushLocationCampaigns,
  clientAgentMemory,
  agentMatchDecisions,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { ApplyHandler, ApplyInput, ApplyResult } from "./applyPipeline";

interface CommunicationResultJson {
  externalSourceId: string;
  clientId?: string | null;
  sourceType: string;
  sourceSubtype?: string;
  title: string;
  timestamp: string;
  direction?: string;
  participantsJson?: unknown;
  contentText?: string;
  contentPreview?: string;
  externalThreadId?: string;
  externalUrl?: string;
  rawPayloadJson?: unknown;
  matchMethod?: string;
  matchConfidence?: number;
  matchStatus?: string;
  isTouchpoint?: boolean;
  version?: string;
}

export const communicationApply: ApplyHandler = {
  applyTarget: "raw_communication_records",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as CommunicationResultJson;
    if (!data.externalSourceId) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_external_source_id" },
      };
    }

    const [existing] = await workerDb
      .select({ id: rawCommunicationRecords.id })
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, data.externalSourceId))
      .limit(1);

    if (existing) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "duplicate_external_source_id", existingId: existing.id },
      };
    }

    const [inserted] = await workerDb
      .insert(rawCommunicationRecords)
      .values({
        clientId: data.clientId ?? null,
        sourceType: data.sourceType,
        sourceSubtype: data.sourceSubtype ?? null,
        title: data.title,
        timestamp: new Date(data.timestamp),
        direction: data.direction ?? null,
        participantsJson: data.participantsJson ?? null,
        contentText: data.contentText ?? null,
        contentPreview: data.contentPreview ?? null,
        externalSourceId: data.externalSourceId,
        externalThreadId: data.externalThreadId ?? null,
        externalUrl: data.externalUrl ?? null,
        rawPayloadJson: data.rawPayloadJson ?? null,
        matchMethod: data.matchMethod ?? null,
        matchConfidence: data.matchConfidence ?? null,
        matchStatus: data.matchStatus ?? "unmatched",
        isTouchpoint: data.isTouchpoint ?? false,
        processingStatus: "pending",
        reviewStatus: "unreviewed",
      })
      .onConflictDoNothing()
      .returning({ id: rawCommunicationRecords.id });

    if (!inserted) {
      const [raceExisting] = await workerDb
        .select({ id: rawCommunicationRecords.id })
        .from(rawCommunicationRecords)
        .where(eq(rawCommunicationRecords.externalSourceId, data.externalSourceId))
        .limit(1);
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "duplicate_external_source_id_conflict", existingId: raceExisting?.id },
      };
    }

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: { insertedId: inserted.id },
    };
  },
};

interface MeetingResultJson {
  externalSourceId: string;
  clientId?: string | null;
  title: string;
  timestamp: string;
  direction?: string;
  participantsJson?: unknown;
  contentText?: string;
  contentPreview?: string;
  externalUrl?: string;
  rawPayloadJson?: unknown;
  googleDriveFileUrl?: string;
  matchMethod?: string;
  matchConfidence?: number;
  matchStatus?: string;
  isTouchpoint?: boolean;
  version?: string;
}

export const meetingApply: ApplyHandler = {
  applyTarget: "raw_communication_records:meeting",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as MeetingResultJson;
    if (!data.externalSourceId) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_external_source_id" },
      };
    }

    const [existing] = await workerDb
      .select({ id: rawCommunicationRecords.id })
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, data.externalSourceId))
      .limit(1);

    if (existing) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "duplicate_meeting", existingId: existing.id },
      };
    }

    const [inserted] = await workerDb
      .insert(rawCommunicationRecords)
      .values({
        clientId: data.clientId ?? null,
        sourceType: "zoom",
        sourceSubtype: "zoom_meeting",
        title: data.title,
        timestamp: new Date(data.timestamp),
        direction: data.direction ?? "internal",
        participantsJson: data.participantsJson ?? null,
        contentText: data.contentText ?? null,
        contentPreview: data.contentPreview ?? null,
        externalSourceId: data.externalSourceId,
        externalUrl: data.externalUrl ?? null,
        rawPayloadJson: data.rawPayloadJson ?? null,
        googleDriveFileUrl: data.googleDriveFileUrl ?? null,
        matchMethod: data.matchMethod ?? null,
        matchConfidence: data.matchConfidence ?? null,
        matchStatus: data.matchStatus ?? "unmatched",
        isTouchpoint: data.isTouchpoint ?? false,
        processingStatus: "pending",
        reviewStatus: "unreviewed",
        transcriptStatus: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: rawCommunicationRecords.id });

    if (!inserted) {
      const [raceExisting] = await workerDb
        .select({ id: rawCommunicationRecords.id })
        .from(rawCommunicationRecords)
        .where(eq(rawCommunicationRecords.externalSourceId, data.externalSourceId))
        .limit(1);
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "duplicate_meeting_conflict", existingId: raceExisting?.id },
      };
    }

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: { insertedId: inserted.id },
    };
  },
};

interface TranscriptResultJson {
  externalSourceId: string;
  meetingExternalSourceId: string;
  contentText: string;
  transcriptStatus: "ready" | "failed";
  version?: string;
}

export const transcriptApply: ApplyHandler = {
  applyTarget: "raw_communication_records:transcript",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as TranscriptResultJson;
    if (!data.meetingExternalSourceId) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_meeting_external_source_id" },
      };
    }

    const [meeting] = await workerDb
      .select({ id: rawCommunicationRecords.id, transcriptStatus: rawCommunicationRecords.transcriptStatus })
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, data.meetingExternalSourceId))
      .limit(1);

    if (!meeting) {
      return {
        outcome: "failed",
        applyTarget: this.applyTarget,
        errorCode: "MEETING_NOT_FOUND",
        errorMessage: `Meeting not found for externalSourceId=${data.meetingExternalSourceId}`,
      };
    }

    if (meeting.transcriptStatus === "ready") {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "transcript_already_ready", meetingId: meeting.id },
      };
    }

    const now = new Date();
    await workerDb
      .update(rawCommunicationRecords)
      .set({
        contentText: data.contentText,
        transcriptStatus: data.transcriptStatus,
        processingStatus: data.transcriptStatus === "ready" ? "processed" : "failed",
        updatedAt: now,
      })
      .where(
        and(
          eq(rawCommunicationRecords.id, meeting.id),
          sql`${rawCommunicationRecords.transcriptStatus} != 'ready'`,
        ),
      );

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: { updatedMeetingId: meeting.id, transcriptStatus: data.transcriptStatus },
    };
  },
};

interface LocalReportResultJson {
  clientId: string;
  locationId: string;
  locationName: string;
  campaignId: string;
  keywordId?: string;
  keywordName: string;
  reportDate: string;
  businessLat: number;
  businessLng: number;
  businessName?: string;
  gridTemplate: string;
  gridUnit: string;
  gridDistance: number;
  baseLat: number;
  baseLng: number;
  pointsNumber?: number;
  shareOfVoiceRaw?: number;
  rawPayload: unknown;
  points?: Array<{
    pointId: string;
    pointIndex?: number;
    lat: number;
    lng: number;
    position?: number;
    diff?: number;
    isEnabled?: boolean;
  }>;
  metrics?: {
    avgRank?: number;
    medianRank?: number;
    bestRank?: number;
    worstRank?: number;
    top3CoveragePct?: number;
    top10CoveragePct?: number;
    rankedPointsCount?: number;
    unrankedPointsCount?: number;
  };
  version?: string;
}

export const localReportApply: ApplyHandler = {
  applyTarget: "heatmap_snapshots",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as LocalReportResultJson;
    if (!data.campaignId || !data.keywordName || !data.reportDate) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_required_fields" },
      };
    }

    const reportDate = new Date(data.reportDate);

    const [existing] = await workerDb
      .select({ id: heatmapSnapshots.id })
      .from(heatmapSnapshots)
      .where(
        and(
          eq(heatmapSnapshots.campaignId, data.campaignId),
          eq(heatmapSnapshots.keywordName, data.keywordName),
          eq(heatmapSnapshots.locationId, data.locationId),
          eq(heatmapSnapshots.reportDate, reportDate),
        ),
      )
      .limit(1);

    let snapshotId: string;
    let wasExisting = false;

    if (existing) {
      snapshotId = existing.id;
      wasExisting = true;
    } else {
      // Task #4054 — the inventory-sync fallback path reaches this handler
      // with clientId undefined (no mapping row at enqueue time). Resolve it
      // at snapshot creation via the same unambiguous campaign→client rule
      // the backfill prod-action uses; NULL only for genuinely ambiguous or
      // unmatched campaigns. Best-effort — never blocks the apply.
      let resolvedClientId: string | null = data.clientId ?? null;
      if (!resolvedClientId) {
        try {
          const { resolveUnambiguousClientForCampaign } = await import(
            "./heatmapClientBackfill"
          );
          resolvedClientId = await resolveUnambiguousClientForCampaign(
            workerDb,
            data.campaignId,
          );
        } catch (err: any) {
          console.warn(
            `[localReportApply] Client-link resolution failed for campaign ${data.campaignId} (non-fatal, snapshot stays unlinked):`,
            err?.message,
          );
          resolvedClientId = null;
        }
      }
      const [snapshot] = await workerDb
        .insert(heatmapSnapshots)
        .values({
          clientId: resolvedClientId,
          locationId: data.locationId,
          locationName: data.locationName,
          businessName: data.businessName ?? null,
          campaignId: data.campaignId,
          keywordId: data.keywordId ?? null,
          keywordName: data.keywordName,
          reportDate,
          businessLat: data.businessLat,
          businessLng: data.businessLng,
          gridTemplate: data.gridTemplate,
          gridUnit: data.gridUnit,
          gridDistance: data.gridDistance,
          baseLat: data.baseLat,
          baseLng: data.baseLng,
          pointsNumber: data.pointsNumber ?? null,
          shareOfVoiceRaw: data.shareOfVoiceRaw ?? null,
          rawPayload: data.rawPayload,
        })
        .returning({ id: heatmapSnapshots.id });
      snapshotId = snapshot.id;
    }

    let pointsInserted = 0;
    if (data.points && data.points.length > 0) {
      const [existingPointCount] = await workerDb
        .select({ count: sql<number>`count(*)::int` })
        .from(heatmapPoints)
        .where(eq(heatmapPoints.snapshotId, snapshotId));

      if ((existingPointCount?.count ?? 0) < data.points.length) {
        if ((existingPointCount?.count ?? 0) > 0) {
          await workerDb.delete(heatmapPoints).where(eq(heatmapPoints.snapshotId, snapshotId));
        }

        const pointValues = data.points.map((p) => ({
          snapshotId,
          pointId: p.pointId,
          pointIndex: p.pointIndex ?? null,
          lat: p.lat,
          lng: p.lng,
          position: p.position ?? null,
          diff: p.diff ?? null,
          isEnabled: p.isEnabled ?? true,
        }));

        for (let i = 0; i < pointValues.length; i += 100) {
          const batch = pointValues.slice(i, i + 100);
          await workerDb.insert(heatmapPoints).values(batch);
        }
        pointsInserted = data.points.length;
      } else {
        pointsInserted = existingPointCount?.count ?? 0;
      }
    }

    let metricsApplied = false;
    if (data.metrics) {
      const [existingMetric] = await workerDb
        .select({ id: heatmapMetrics.id })
        .from(heatmapMetrics)
        .where(eq(heatmapMetrics.snapshotId, snapshotId))
        .limit(1);

      if (!existingMetric) {
        await workerDb.insert(heatmapMetrics).values({
          snapshotId,
          avgRank: data.metrics.avgRank ?? null,
          medianRank: data.metrics.medianRank ?? null,
          bestRank: data.metrics.bestRank ?? null,
          worstRank: data.metrics.worstRank ?? null,
          top3CoveragePct: data.metrics.top3CoveragePct ?? null,
          top10CoveragePct: data.metrics.top10CoveragePct ?? null,
          rankedPointsCount: data.metrics.rankedPointsCount ?? null,
          unrankedPointsCount: data.metrics.unrankedPointsCount ?? null,
        });
        metricsApplied = true;
      }
    }

    const newSnapshotCreated = !wasExisting;
    if (!newSnapshotCreated && pointsInserted === 0 && !metricsApplied) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: { reason: "fully_applied_on_retry", snapshotId },
      };
    }

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: {
        snapshotId,
        wasExisting,
        pointsInserted,
        metricsApplied,
      },
    };
  },
};

interface MatchStateResultJson {
  clientId: string;
  communicationId?: string;
  decisions?: Array<{
    communicationId: string;
    communicationType: string;
    clientId: string;
    confidenceScore: number;
    status: string;
    explanationSummary?: string;
    semanticReasoningSummary?: string;
    supportingSignalsJson?: unknown;
    evidenceType?: string;
  }>;
  memoryUpdates?: Array<{
    clientId: string;
    identifierType: string;
    identifierValue: string;
    confidenceWeight?: number;
    source?: string;
  }>;
  version?: string;
}

export const matchStateApply: ApplyHandler = {
  applyTarget: "agent_match_state",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as MatchStateResultJson;
    let decisionsApplied = 0;
    let memoriesApplied = 0;
    let decisionsSkipped = 0;
    let memoriesSkipped = 0;

    if (data.decisions && data.decisions.length > 0) {
      for (const decision of data.decisions) {
        const [existing] = await workerDb
          .select({ id: agentMatchDecisions.id })
          .from(agentMatchDecisions)
          .where(
            and(
              eq(agentMatchDecisions.communicationId, decision.communicationId),
              eq(agentMatchDecisions.clientId, decision.clientId),
            ),
          )
          .limit(1);

        if (existing) {
          decisionsSkipped++;
          continue;
        }

        await workerDb.insert(agentMatchDecisions).values({
          communicationId: decision.communicationId,
          communicationType: decision.communicationType,
          clientId: decision.clientId,
          confidenceScore: decision.confidenceScore,
          status: decision.status,
          explanationSummary: decision.explanationSummary ?? null,
          semanticReasoningSummary: decision.semanticReasoningSummary ?? null,
          supportingSignalsJson: decision.supportingSignalsJson ?? null,
          evidenceType: decision.evidenceType ?? "structured",
        });
        decisionsApplied++;
      }
    }

    if (data.memoryUpdates && data.memoryUpdates.length > 0) {
      for (const mem of data.memoryUpdates) {
        const [existing] = await workerDb
          .select({ id: clientAgentMemory.id })
          .from(clientAgentMemory)
          .where(
            and(
              eq(clientAgentMemory.clientId, mem.clientId),
              eq(clientAgentMemory.identifierType, mem.identifierType),
              eq(clientAgentMemory.identifierValue, mem.identifierValue),
            ),
          )
          .limit(1);

        if (existing) {
          const now = new Date();
          await workerDb
            .update(clientAgentMemory)
            .set({
              lastSeenAt: now,
              updatedAt: now,
            })
            .where(eq(clientAgentMemory.id, existing.id));
          memoriesSkipped++;
          continue;
        }

        await workerDb.insert(clientAgentMemory).values({
          clientId: mem.clientId,
          identifierType: mem.identifierType,
          identifierValue: mem.identifierValue,
          confidenceWeight: mem.confidenceWeight ?? 1.0,
          source: mem.source ?? "durable_pipeline",
        });
        memoriesApplied++;
      }
    }

    const totalApplied = decisionsApplied + memoriesApplied;
    const totalSkipped = decisionsSkipped + memoriesSkipped;

    if (totalApplied === 0) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: {
          reason: totalSkipped > 0 ? "all_already_applied" : "no_actionable_data",
          decisionsSkipped,
          memoriesSkipped,
        },
      };
    }

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: {
        decisionsApplied,
        decisionsSkipped,
        memoriesApplied,
        memoriesSkipped,
      },
    };
  },
};

interface InventorySyncResultJson {
  clientId: string;
  semrushCampaignId?: string;
  integrationEnabled?: boolean;
  businessName?: string;
  businessLocationId?: string;
  defaultGridSize?: string;
  syncStatus?: string;
  locationCampaigns?: Array<{
    clientId: string;
    locationId: string;
    semrushCampaignId: string;
    semrushCampaignName?: string;
    isStale?: boolean;
  }>;
  version?: string;
}

export const inventorySyncApply: ApplyHandler = {
  applyTarget: "client_semrush_integrations",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as InventorySyncResultJson;
    if (!data.clientId) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_client_id" },
      };
    }

    let integrationUpserted = false;
    let locationCampaignsApplied = 0;
    let locationCampaignsSkipped = 0;

    if (data.semrushCampaignId || data.integrationEnabled !== undefined) {
      const now = new Date();
      const [existing] = await workerDb
        .select({ id: clientSemrushIntegrations.id })
        .from(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, data.clientId))
        .limit(1);

      if (existing) {
        const updateFields: Record<string, unknown> = { updatedAt: now };
        if (data.semrushCampaignId !== undefined) updateFields.semrushCampaignId = data.semrushCampaignId;
        if (data.integrationEnabled !== undefined) updateFields.integrationEnabled = data.integrationEnabled;
        if (data.businessName !== undefined) updateFields.businessName = data.businessName;
        if (data.businessLocationId !== undefined) updateFields.businessLocationId = data.businessLocationId;
        if (data.defaultGridSize !== undefined) updateFields.defaultGridSize = data.defaultGridSize;
        if (data.syncStatus !== undefined) updateFields.syncStatus = data.syncStatus;

        await workerDb
          .update(clientSemrushIntegrations)
          .set(updateFields)
          .where(eq(clientSemrushIntegrations.id, existing.id));
        integrationUpserted = true;
      } else {
        await workerDb.insert(clientSemrushIntegrations).values({
          clientId: data.clientId,
          semrushCampaignId: data.semrushCampaignId ?? null,
          integrationEnabled: data.integrationEnabled ?? true,
          businessName: data.businessName ?? null,
          businessLocationId: data.businessLocationId ?? null,
          defaultGridSize: data.defaultGridSize ?? "9x9",
          syncStatus: data.syncStatus ?? "idle",
        });
        integrationUpserted = true;
      }
    }

    let locationCampaignsDropped = 0;
    if (data.locationCampaigns && data.locationCampaigns.length > 0) {
      // Task #920C: Route create candidates through the canonical helper so
      // dedup, parent-validation, stale-conflict handling, and review-queue
      // routing stay identical across all SEMrush mapping write sites.
      const { applySemrushLocationMapping } = await import("./semrushLocationMappingWriter");

      for (const lc of data.locationCampaigns) {
        // Stale-flip updates against an already-mapped row are a legitimate
        // update path that the helper does not cover (the helper never
        // mutates isStale on existing rows). Handle them inline here so the
        // queue payload's `isStale` field still flows through.
        const [existing] = await workerDb
          .select({ id: semrushLocationCampaigns.id })
          .from(semrushLocationCampaigns)
          .where(
            and(
              eq(semrushLocationCampaigns.clientId, lc.clientId),
              eq(semrushLocationCampaigns.locationId, lc.locationId),
              eq(semrushLocationCampaigns.semrushCampaignId, lc.semrushCampaignId),
            ),
          )
          .limit(1);

        if (existing) {
          if (lc.isStale !== undefined) {
            await workerDb
              .update(semrushLocationCampaigns)
              .set({
                isStale: lc.isStale,
                staleSince: lc.isStale ? new Date() : null,
              })
              .where(eq(semrushLocationCampaigns.id, existing.id));
            // Task #1208: if this flip un-staled the row, the integration's
            // "campaign(s) marked stale" warning may now be obsolete.
            if (lc.isStale === false) {
              try {
                const { clearStaleWarningIfResolved } = await import("./semrushStaleWarningClear");
                await clearStaleWarningIfResolved(lc.clientId);
              } catch (e: any) {
                console.warn(`[InventorySyncApply] clearStaleWarningIfResolved failed (non-fatal): ${e?.message}`);
              }
            }
          }
          locationCampaignsApplied++;
          continue;
        }

        try {
          const outcome = await applySemrushLocationMapping({
            clientId: lc.clientId,
            locationId: lc.locationId,
            semrushCampaignId: lc.semrushCampaignId,
            semrushCampaignName: lc.semrushCampaignName ?? null,
            source: {
              surface: "semrush_inventory",
              sourceRef: { applyTarget: this.applyTarget },
            },
          });
          switch (outcome.kind) {
            case "saved":
            case "already_mapped":
              locationCampaignsApplied++;
              break;
            case "queued_for_review":
            case "invalid_parent":
            case "stale_conflict":
            case "blocked":
              locationCampaignsDropped++;
              break;
          }
        } catch (err) {
          console.error(`[InventorySync] Helper failed for client=${lc.clientId} location=${lc.locationId} campaign=${lc.semrushCampaignId}:`, err);
          locationCampaignsDropped++;
        }
      }
    }

    if (!integrationUpserted && locationCampaignsApplied === 0) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        appliedVersion: data.version,
        responseJson: {
          reason: locationCampaignsSkipped > 0 ? "all_already_applied"
                : locationCampaignsDropped > 0 ? "all_unconfigured"
                : "no_actionable_payload",
          locationCampaignsSkipped,
          locationCampaignsDropped,
        },
      };
    }

    return {
      outcome: "success",
      applyTarget: this.applyTarget,
      appliedVersion: data.version,
      responseJson: {
        integrationUpserted,
        locationCampaignsApplied,
        locationCampaignsSkipped,
        locationCampaignsDropped,
      },
    };
  },
};

export const semrushHeatmapApply: ApplyHandler = {
  applyTarget: "heatmap_snapshots",

  async handle(input: ApplyInput): Promise<ApplyResult> {
    const data = input.resultJson as any;
    if (!data.campaignId || !data.keywordName) {
      return {
        outcome: "skipped",
        applyTarget: this.applyTarget,
        responseJson: { reason: "missing_required_fields" },
      };
    }

    try {
      const { importHeatmap } = await import("./heatmapService");
      const result = await importHeatmap(data);
      // Task #1785: record the applied hash so subsequent refreshes
      // with an identical payload can short-circuit the apply enqueue.
      // Best-effort; hash absence just disables suppression next time.
      if (typeof data.__responseHash === "string" && data.campaignId) {
        try {
          const { recordAppliedHash } = await import("./semrushCadenceGate");
          await recordAppliedHash({
            key: {
              campaignId: data.campaignId,
              locationId: data.locationId,
              snapshotKey: `${data.keywordId ?? data.keywordName}:${data.reportDate ?? ""}`,
            },
            responseHash: data.__responseHash,
          });
        } catch {}
      }
      return {
        outcome: "success",
        applyTarget: this.applyTarget,
        appliedVersion: data.reportDate,
        responseJson: {
          snapshotId: result.snapshotId,
          pointCount: result.pointCount,
        },
      };
    } catch (err: any) {
      return {
        outcome: "failed",
        applyTarget: this.applyTarget,
        errorMessage: err?.message || String(err),
      };
    }
  },
};

export const allApplyHandlers: Record<string, ApplyHandler> = {
  communication_apply: communicationApply,
  meeting_apply: meetingApply,
  transcript_apply: transcriptApply,
  local_report_apply: localReportApply,
  match_state_apply: matchStateApply,
  inventory_sync_apply: inventorySyncApply,
  semrush_heatmap_apply: semrushHeatmapApply,
};

export function getApplyHandler(resultType: string): ApplyHandler | undefined {
  return allApplyHandlers[resultType];
}
