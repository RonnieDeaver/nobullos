// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Report & content hygiene — keyword spellings, heatmap client links, link previews, Common Issues reformatting, report-section backfills.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { sql } from "drizzle-orm";
import { FRESH_SLATE_DESTRUCTIVE_CONFIRMATION } from "@shared/clientRating";
import { getDb, withDbAttribution } from "../../db";
import { storage } from "../../storage";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
  type DrainState,
  type DrainChunkResult,
} from "../prodActionBackgroundDrain";
import {
  findReformatCandidateSections,
  processReformatSection,
  COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
} from "../commonIssuesReformatBackfill";
import {
  scanPlaceholderCommonIssues,
  clearPlaceholderCommonIssuesCandidates,
} from "../placeholderCommonIssuesCleanup";
import {
  countNonCanonicalKeywordSnapshots,
  rewriteNonCanonicalKeywordBatch,
  isCanonicalKeywordConstraintPresent,
  ensureCanonicalKeywordConstraint,
  KEYWORD_SPELLING_CLEANUP_BATCH,
} from "../legacyKeywordSpellingCleanup";
import {
  countBackfillableNullClientSnapshots,
  summarizeNullClientSnapshots,
  backfillHeatmapSnapshotClientBatch,
  HEATMAP_CLIENT_BACKFILL_BATCH,
} from "../heatmapClientBackfill";
import {
  LINK_PREVIEW_SANITIZE_BATCH,
  countStaticallyBadLinkPreviewRows,
  countStaticallyBadMessagePreviewRows,
  isSanitizeBackfillStamped,
  stampSanitizeBackfillDone,
  sanitizeLinkPreviewRowsChunk,
  sanitizeMessagePreviewsChunk,
} from "../linkPreviewSanitizeBackfill";
import {
  countPendingThumbnailBackfill,
  processThumbnailBackfillChunk,
  getThumbnailBackfillSkippedCount,
  COMMS_THUMBNAIL_BACKFILL_CHUNK,
} from "../commsAttachmentThumbnailBackfill";
import {
  SEASONAL_TREND_AI_BACKFILL_CHUNK,
  SEASONAL_TREND_AI_BACKFILL_DELAY_MS,
} from "../seasonalTrendAiBackfill";
import {
  findDegenerateFinalReportSections,
  processDegenerateRepairSection,
  DEGENERATE_COPY_REPAIR_VERSION,
} from "../degenerateCommonIssuesRepair";
import {
  purgeSlideVerdictCandidate,
  scanSlideVerdictPurgeCandidates,
  type SlideVerdictPurgeCandidate,
} from "../slideVerdictPurge";
import { type ProdAction, type ProdActionDomain } from "./kernel";


// ──── Task #2265: re-run stale Semrush partial / paused-auth locations ────
//
// The Local Dominance per-location sync writes a canonical state row per
// (clientId, locationId, campaignId). Two non-terminal states leave a
// location stuck without ever self-healing:
//   - `partial`: imported some-but-not-all keywords and the run ended (e.g.
//     the long-stale April rows) — re-running can fill coverage.
//   - `paused_auth`: a sweep paused on missing auth and a later healthy sweep
//     never cleared it (leftover) — re-running picks it up now auth is back.
// One press starts a worker-pool background drain that, for each stale row,
// resets the bounded retry budget (`resetForManualRetry`) and re-drives ONLY
// that location via `syncSingleClient({ restrictToLocationId })`. SEMrush
// circuit-breaker / auth-breaker aware (stops cleanly; a later press resumes),
// idempotent (only ever touches partial/paused_auth rows), and self-heal
// eligible so the CEO no longer re-runs stale partials by hand.
// ─── Task #2476: clean up legacy non-canonical keyword spellings ─────
//
// Task #2451 fixed the read-path DISPLAY so the same keyword stored under
// inconsistent legacy SEMrush spellings (e.g. "Immigration Attorney" vs
// "immigration  attorney") collapses to a single pill — but it did NOT
// rewrite the underlying `heatmap_snapshots.keyword_name` rows. Migration
// 0061 added a CHECK constraint forcing canonical spellings going forward,
// so any non-canonical rows are necessarily LEGACY (predate the constraint).
// `scripts/cleanup-legacy-keyword-spellings.ts` does the rewrite, but the
// dev workspace can only READ prod (memory "Backfill from read-only-prod
// dev"), so a CLI run in dev changes nothing real. This prod-action runs
// the same canonicalizing rewrite inside the deployed app against the real
// DB, and then ensures the migration-0061 constraint is present.
//
// Convergence: the drain's `countPending` is (non-canonical rows) + (1 if
// the canonical CHECK constraint is missing). `runChunk` first rewrites a
// batch of non-canonical rows; once none remain it adds the constraint (if
// missing) exactly once; then returns 0 to end the drain. So a single press
// both rewrites every row AND makes the invariant durable, and a re-press
// against an already-clean+constrained table is `not-needed`. Self-heal
// eligible so the CEO never has to run it by hand.
//
// Confirmed live state (2026-06-13, read-only prod): the constraint is
// already present and there are 0 non-canonical rows, so in prod today this
// action reports `not-needed`. It is the executable, idempotent safety net
// for the rewrite that the read-only-dev CLI can never perform itself.
const CLEANUP_LEGACY_KEYWORD_SPELLINGS_ID = "cleanup_legacy_keyword_spellings";


async function countKeywordCleanupPending(): Promise<number> {
  return withDbAttribution(
    "maintenance:prod-actions-keyword-spelling-cleanup-count",
    async () => {
      const db = getDb();
      const nonCanonical = await countNonCanonicalKeywordSnapshots(db);
      const present = await isCanonicalKeywordConstraintPresent(db);
      return nonCanonical + (present ? 0 : 1);
    },
  );
}


export const cleanupLegacyKeywordSpellingsAction: ProdAction = {
  id: CLEANUP_LEGACY_KEYWORD_SPELLINGS_ID,
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Clean up legacy non-canonical keyword spellings (Task #2476)",
  description:
    "Rewrites any legacy `heatmap_snapshots.keyword_name` saved under a non-canonical SEMrush spelling (mixed case / leading-trailing or doubled internal whitespace) to its canonical form — trim, collapse internal whitespace, lowercase — mirroring `normalizeKeyword` exactly. Task #2451 fixed only the read-path display; this rewrites the data itself so SoV / coverage math that groups by raw keyword stays consistent. One-and-done: a single press starts a worker-pool background drain that rewrites rows in " +
    String(KEYWORD_SPELLING_CLEANUP_BATCH) +
    "-row chunks (FOR UPDATE SKIP LOCKED, well under the 10s DB-hold cap), then ensures the migration-0061 canonical CHECK constraint is present so non-canonical spellings can never be reintroduced. Pure column rename — never merges rows; idempotent (only matches still-non-canonical rows); self-heals. Reports `not-needed` once every row is canonical and the constraint exists.",
  change:
    "Background-drain UPDATE heatmap_snapshots SET keyword_name = lower(regexp_replace(btrim(keyword_name),'\\\\s+',' ','g')) WHERE keyword_name is non-canonical, " +
    String(KEYWORD_SPELLING_CLEANUP_BATCH) +
    " rows/chunk on the worker pool; then ADD CONSTRAINT heatmap_snapshots_keyword_name_canonical_chk if missing.",
  // Self-heal eligible (Task #2086) — cheap, idempotent, and rarely has
  // anything to do once converged, so a relaxed cadence is plenty.
  selfHeal: { cadenceMs: 6 * 60 * 60_000, backoffMs: 24 * 60 * 60_000 },
  async status() {
    if (isDrainRunning(CLEANUP_LEGACY_KEYWORD_SPELLINGS_ID)) {
      const s = getDrainState(CLEANUP_LEGACY_KEYWORD_SPELLINGS_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { nonCanonical, constraintMissing } = await withDbAttribution(
      "maintenance:prod-actions-keyword-spelling-cleanup-count",
      async () => {
        const db = getDb();
        const n = await countNonCanonicalKeywordSnapshots(db);
        const present = await isCanonicalKeywordConstraintPresent(db);
        return { nonCanonical: n, constraintMissing: !present };
      },
    );
    if (nonCanonical === 0 && !constraintMissing) {
      return {
        state: "not-needed",
        detail:
          "Every heatmap_snapshots keyword spelling is already canonical and the canonical CHECK constraint is present.",
      };
    }
    const parts: string[] = [];
    if (nonCanonical > 0) {
      parts.push(`${nonCanonical} non-canonical keyword row(s)`);
    }
    if (constraintMissing) {
      parts.push("the canonical CHECK constraint is missing");
    }
    return {
      state: "pending",
      detail: `${parts.join(" and ")}; a single press rewrites them ${KEYWORD_SPELLING_CLEANUP_BATCH} row(s) per chunk and ensures the constraint.`,
    };
  },
  async apply(actorId) {
    const out = await startBackgroundDrain(
      {
        actionId: CLEANUP_LEGACY_KEYWORD_SPELLINGS_ID,
        actionTitle: "Clean up legacy non-canonical keyword spellings",
        attributionLabel: "maintenance:prod-actions-keyword-spelling-cleanup",
        unit: "row(s)",
        countPending: () => countKeywordCleanupPending(),
        runChunk: (): Promise<DrainChunkResult> =>
          withDbAttribution(
            "maintenance:prod-actions-keyword-spelling-cleanup",
            async (): Promise<DrainChunkResult> => {
              const db = getDb();
              const rewritten = await rewriteNonCanonicalKeywordBatch(
                db,
                KEYWORD_SPELLING_CLEANUP_BATCH,
              );
              if (rewritten > 0) {
                return { processed: rewritten, perKey: { rewritten } };
              }
              // No non-canonical rows remain — make the invariant durable.
              // Counts as one unit of work so `countPending`'s +1 (when the
              // constraint was missing) matches what the drain processed.
              const added = await ensureCanonicalKeywordConstraint(db);
              if (added) {
                return { processed: 1, perKey: { constraint_added: 1 } };
              }
              return { processed: 0 };
            },
          ),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// Task #2895 — backfill client_id on heatmap snapshots imported before the
// import path captured the client link ("No client linked" in the Browse
// tab). Resolution is via the snapshot's SEMrush campaign_id against the
// existing campaign → client bindings (semrush_location_campaigns ∪
// client_semrush_integrations); only campaigns claimed by exactly ONE
// distinct client are stamped — ambiguous or unmatched campaigns leave
// their snapshots NULL and are surfaced in status() (never guessed,
// mirroring the GBP report-location ghosts decision).
//
// Convergence: countPending counts ONLY resolvable rows, so unmatched /
// ambiguous rows never hold the action in perpetual "pending" (memory
// "Prod-action convergence"). The UPDATE re-checks client_id IS NULL, so
// re-pressing is safe; a later press picks up campaigns that became
// resolvable after a new binding appeared.
const BACKFILL_HEATMAP_SNAPSHOT_CLIENT_ID = "backfill_heatmap_snapshot_client_links";


export const backfillHeatmapSnapshotClientLinksAction: ProdAction = {
  id: BACKFILL_HEATMAP_SNAPSHOT_CLIENT_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot backfill linking legacy heatmap snapshots to clients — a re-arm means new snapshots are being written unlinked, a writer regression to investigate.",
  },
  title: "Backfill client links on unlinked heatmap snapshots (Task #2895)",
  description:
    "Stamps `heatmap_snapshots.client_id` on rows imported before the import path captured the client link (they show \"No client linked\" in the heatmap Browse tab). A snapshot is linked ONLY when its SEMrush campaign_id maps to exactly one client across the existing campaign→client bindings (semrush_location_campaigns and client_semrush_integrations). Snapshots whose campaign is claimed by multiple clients (ambiguous) or by no client (unmatched) are left NULL and their counts are surfaced here — never guessed. One press starts a worker-pool background drain that stamps rows in " +
    String(HEATMAP_CLIENT_BACKFILL_BATCH) +
    "-row chunks (FOR UPDATE SKIP LOCKED, single-statement UPDATE well under the 10s DB-hold cap). Idempotent and convergent: only NULL-client rows with an unambiguous match count as pending, and the UPDATE never overwrites an existing link.",
  change:
    "Background-drain UPDATE heatmap_snapshots SET client_id = <unambiguous campaign→client match> WHERE client_id IS NULL, " +
    String(HEATMAP_CLIENT_BACKFILL_BATCH) +
    " rows/chunk on the worker pool. Ambiguous / unmatched campaigns are left NULL and surfaced in the action status.",
  async status() {
    if (isDrainRunning(BACKFILL_HEATMAP_SNAPSHOT_CLIENT_ID)) {
      const s = getDrainState(BACKFILL_HEATMAP_SNAPSHOT_CLIENT_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const summary = await withDbAttribution(
      "maintenance:prod-actions-heatmap-client-backfill-count",
      async () => summarizeNullClientSnapshots(getDb()),
    );
    const surfaced: string[] = [];
    if (summary.ambiguous > 0) {
      surfaced.push(
        `${summary.ambiguous} row(s) whose campaign is claimed by multiple clients (ambiguous — left unlinked)`,
      );
    }
    if (summary.unmatched > 0) {
      surfaced.push(
        `${summary.unmatched} row(s) whose campaign has no client binding (unmatched — left unlinked)`,
      );
    }
    if (summary.resolvable === 0) {
      const surfacedNote = surfaced.length > 0
        ? ` Remaining unlinked: ${surfaced.join("; ")}. These are surfaced, never guessed — they resolve themselves once a campaign→client binding exists.`
        : "";
      return {
        state: "not-needed",
        detail: `No unlinked heatmap snapshot has an unambiguous campaign→client match.${surfacedNote}`,
      };
    }
    const surfacedNote = surfaced.length > 0
      ? ` Also unlinked but NOT touched: ${surfaced.join("; ")}.`
      : "";
    return {
      state: "pending",
      detail:
        `${summary.resolvable} unlinked heatmap snapshot(s) resolve unambiguously via their SEMrush campaign; ` +
        `a single press stamps them ${HEATMAP_CLIENT_BACKFILL_BATCH} row(s) per chunk.${surfacedNote}`,
    };
  },
  async apply(actorId) {
    const out = await startBackgroundDrain(
      {
        actionId: BACKFILL_HEATMAP_SNAPSHOT_CLIENT_ID,
        actionTitle: "Backfill client links on unlinked heatmap snapshots",
        attributionLabel: "maintenance:prod-actions-heatmap-client-backfill",
        unit: "row(s)",
        countPending: () =>
          withDbAttribution(
            "maintenance:prod-actions-heatmap-client-backfill-count",
            async () => countBackfillableNullClientSnapshots(getDb()),
          ),
        runChunk: (): Promise<DrainChunkResult> =>
          withDbAttribution(
            "maintenance:prod-actions-heatmap-client-backfill",
            async (): Promise<DrainChunkResult> => {
              const stamped = await backfillHeatmapSnapshotClientBatch(
                getDb(),
                HEATMAP_CLIENT_BACKFILL_BATCH,
              );
              if (stamped > 0) {
                return { processed: stamped, perKey: { linked: stamped } };
              }
              return { processed: 0 };
            },
          ),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// Task #3413 — sanitize previously saved link-preview asset URLs. Task
// #3300 made NEW comms link-preview og:image / favicon URLs pass
// `sanitizeAssetUrl` (https-only, public-resolving hosts) before storage,
// but rows persisted earlier — `comms_link_previews.image_url` /
// `favicon_url` and preview payloads already patched into
// `comms_messages.metadata.linkPreviews` — can still hold http:// or
// private-IP asset URLs that logged-in browsers would load.
//
// Convergence: sanitization needs DNS, so `countPending` is
// (statically-detectable bad rows via SQL regex) + (1 if the one-time
// full-DNS-pass stamp `link_preview_sanitize_backfill_done_v1` is
// missing). The drain scans BOTH surfaces in id-keyset chunks, NULLs
// failing asset URLs (still-equals guarded — never clobbers a concurrent
// re-unfurl), then writes the stamp as its final unit of work, so the
// action settles to `not-needed` after one press. Idempotent: re-running
// re-scans but every write re-checks the exact stored value.
const SANITIZE_LINK_PREVIEW_ASSETS_ID = "sanitize_saved_link_preview_assets";


export const sanitizeSavedLinkPreviewAssetsAction: ProdAction = {
  id: SANITIZE_LINK_PREVIEW_ASSETS_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot sanitation of legacy saved link-preview assets — a re-arm means the write-time sanitizer gap reopened; investigate the writer instead of re-scrubbing forever.",
  },
  title: "Sanitize previously saved link-preview asset URLs (Task #3413)",
  description:
    "Runs the Task #3300 `sanitizeAssetUrl` guard (https-only, hostname must resolve to public addresses) over EVERY link-preview asset URL saved before that fix shipped: `comms_link_previews.image_url` / `favicon_url` plus the preview payloads already patched into `comms_messages.metadata.linkPreviews`. Failing URLs are set to NULL so logged-in browsers can never be pointed at http:// or internal-IP assets (client-side SSRF probe vector). One press starts a worker-pool background drain that scans both surfaces " +
    String(LINK_PREVIEW_SANITIZE_BATCH) +
    " row(s) per chunk (DNS lookups happen between short single-row statements — no DB hold spans a network call), then stamps `link_preview_sanitize_backfill_done_v1` in system_settings so the action settles to `not-needed`. Idempotent and safe to re-run: every NULLing UPDATE re-checks the stored value it sanitized, so already-cleaned rows and concurrently re-unfurled previews are never touched.",
  change:
    "Background-drain over comms_link_previews (image_url/favicon_url → NULL when sanitizeAssetUrl fails) and comms_messages.metadata.linkPreviews (per-preview imageUrl/faviconUrl → null, single-key jsonb merge preserving other metadata), " +
    String(LINK_PREVIEW_SANITIZE_BATCH) +
    " row(s)/chunk on the worker pool; final unit writes the `link_preview_sanitize_backfill_done_v1` stamp.",
  async status() {
    if (isDrainRunning(SANITIZE_LINK_PREVIEW_ASSETS_ID)) {
      const s = getDrainState(SANITIZE_LINK_PREVIEW_ASSETS_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { badPreviewRows, badMessageRows, stamped } = await withDbAttribution(
      "maintenance:prod-actions-link-preview-sanitize-count",
      async () => {
        const db = getDb();
        return {
          badPreviewRows: await countStaticallyBadLinkPreviewRows(db),
          badMessageRows: await countStaticallyBadMessagePreviewRows(db),
          stamped: await isSanitizeBackfillStamped(),
        };
      },
    );
    if (badPreviewRows === 0 && badMessageRows === 0 && stamped) {
      return {
        state: "not-needed",
        detail:
          "No statically-detectable bad link-preview asset URL remains and the one-time full DNS sanitization pass has already run.",
      };
    }
    const parts: string[] = [];
    if (badPreviewRows > 0) {
      parts.push(
        `${badPreviewRows} cached preview row(s) with a non-https or literal private-IP asset URL`,
      );
    }
    if (badMessageRows > 0) {
      parts.push(
        `${badMessageRows} message(s) whose saved linkPreviews payload holds one`,
      );
    }
    if (!stamped) {
      parts.push(
        "the one-time full DNS pass (catches hostnames that only resolve to private IPs) has not run yet",
      );
    }
    return {
      state: "pending",
      detail: `${parts.join("; ")}. A single press scans both surfaces ${LINK_PREVIEW_SANITIZE_BATCH} row(s) per chunk and NULLs failing asset URLs.`,
    };
  },
  async apply(actorId) {
    // In-memory per-drain scan state. Keyset cursors advance through each
    // surface; a re-press after a crash restarts the scan from the top,
    // which is safe (idempotent still-equals writes) just re-reads rows.
    let previewCursor: string | null = null;
    let previewsDone = false;
    let messageCursor: string | null = null;
    let messagesDone = false;
    let stampWritten = false;

    const out = await startBackgroundDrain(
      {
        actionId: SANITIZE_LINK_PREVIEW_ASSETS_ID,
        actionTitle: "Sanitize previously saved link-preview asset URLs",
        attributionLabel: "maintenance:prod-actions-link-preview-sanitize",
        unit: "row(s)",
        countPending: () =>
          withDbAttribution(
            "maintenance:prod-actions-link-preview-sanitize-count",
            async () => {
              const db = getDb();
              const bad =
                (await countStaticallyBadLinkPreviewRows(db)) +
                (await countStaticallyBadMessagePreviewRows(db));
              const stamped = await isSanitizeBackfillStamped();
              return bad + (stamped ? 0 : 1);
            },
          ),
        runChunk: (): Promise<DrainChunkResult> =>
          withDbAttribution(
            "maintenance:prod-actions-link-preview-sanitize",
            async (): Promise<DrainChunkResult> => {
              const db = getDb();
              if (!previewsDone) {
                const r = await sanitizeLinkPreviewRowsChunk(
                  db,
                  previewCursor,
                  LINK_PREVIEW_SANITIZE_BATCH,
                );
                previewCursor = r.nextCursor;
                if (r.nextCursor === null) previewsDone = true;
                if (r.scanned > 0) {
                  return {
                    processed: r.scanned,
                    perKey: {
                      previews_scanned: r.scanned,
                      ...(r.cleaned > 0 ? { previews_cleaned: r.cleaned } : {}),
                    },
                  };
                }
                // Surface exhausted with an empty page — fall through to
                // the next surface within the same chunk.
              }
              if (!messagesDone) {
                const r = await sanitizeMessagePreviewsChunk(
                  db,
                  messageCursor,
                  LINK_PREVIEW_SANITIZE_BATCH,
                );
                messageCursor = r.nextCursor;
                if (r.nextCursor === null) messagesDone = true;
                if (r.scanned > 0) {
                  return {
                    processed: r.scanned,
                    perKey: {
                      messages_scanned: r.scanned,
                      ...(r.cleaned > 0 ? { messages_cleaned: r.cleaned } : {}),
                    },
                  };
                }
              }
              // Both surfaces exhausted — make completion durable exactly
              // once per drain. Counts as one unit of work so countPending's
              // +1 (when the stamp was missing) matches what the drain did.
              if (!stampWritten) {
                stampWritten = true;
                const alreadyStamped = await isSanitizeBackfillStamped();
                await stampSanitizeBackfillDone();
                if (!alreadyStamped) {
                  return { processed: 1, perKey: { stamp_written: 1 } };
                }
              }
              return { processed: 0 };
            },
          ),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


const BACKFILL_COMMS_THUMBNAILS_ID = "backfill_comms_attachment_thumbnails";


export const backfillCommsAttachmentThumbnailsAction: ProdAction = {
  id: BACKFILL_COMMS_THUMBNAILS_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot thumbnail backfill for legacy attachments (new attachments get thumbnails at ingest) — a re-arm means the ingest-time generator is failing, which needs investigation.",
  },
  title: "Backfill thumbnails for already-sent image attachments (Task #3421)",
  description:
    "Image attachments sent before upload-time thumbnail generation shipped (Task #3301) have `comms_attachments.thumbnail_key = NULL`, so old messages still download full-resolution originals. One press starts a worker-pool background drain that walks every image attachment row (content_type image/%) with a NULL thumbnail_key, downloads each original from object storage, generates the same 600px-wide webp thumbnail the upload path produces (shared pipeline — comms-attachments/thumb/), and stamps `thumbnail_key`, " +
    String(COMMS_THUMBNAIL_BACKFILL_CHUNK) +
    " attachment(s) per chunk. Best-effort per row: a row whose original is missing or undecodable is logged, skipped, and excluded from the pending count so the drain converges — it simply keeps serving full-res, exactly like today. Idempotent: the UPDATE is guarded by `thumbnail_key IS NULL`, so re-runs never overwrite a thumbnail written by this drain or by a concurrent upload.",
  change:
    "Per pending row: download original → sharp 600px webp → upload under comms-attachments/thumb/ → UPDATE comms_attachments SET thumbnail_key WHERE id = … AND thumbnail_key IS NULL, " +
    String(COMMS_THUMBNAIL_BACKFILL_CHUNK) +
    " row(s)/chunk on the worker pool. No schema change. Skipped failures are surfaced in status, never guessed or forced.",
  async status() {
    if (isDrainRunning(BACKFILL_COMMS_THUMBNAILS_ID)) {
      const s = getDrainState(BACKFILL_COMMS_THUMBNAILS_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const pending = await withDbAttribution(
      "maintenance:prod-actions-comms-thumbnail-backfill-count",
      async () => countPendingThumbnailBackfill(getDb()),
    );
    const skippedCount = getThumbnailBackfillSkippedCount();
    const skippedNote =
      skippedCount > 0
        ? ` ${skippedCount} attachment(s) failed and were skipped this process (missing original or undecodable bytes — they keep serving full-res; a restart clears the skip list so a later press retries them).`
        : "";
    if (pending === 0) {
      return {
        state: "not-needed",
        detail: `Every image attachment already has a thumbnail.${skippedNote}`,
      };
    }
    return {
      state: "pending",
      detail:
        `${pending} image attachment(s) still serve full-resolution originals (thumbnail_key IS NULL); ` +
        `a single press backfills them ${COMMS_THUMBNAIL_BACKFILL_CHUNK} attachment(s) per chunk.${skippedNote}`,
    };
  },
  async apply(actorId) {
    const out = await startBackgroundDrain(
      {
        actionId: BACKFILL_COMMS_THUMBNAILS_ID,
        actionTitle: "Backfill thumbnails for already-sent image attachments",
        attributionLabel: "maintenance:prod-actions-comms-thumbnail-backfill",
        unit: "attachment(s)",
        countPending: () =>
          withDbAttribution(
            "maintenance:prod-actions-comms-thumbnail-backfill-count",
            async () => countPendingThumbnailBackfill(getDb()),
          ),
        runChunk: (): Promise<DrainChunkResult> =>
          withDbAttribution(
            "maintenance:prod-actions-comms-thumbnail-backfill",
            async (): Promise<DrainChunkResult> => {
              const out = await processThumbnailBackfillChunk(
                getDb(),
                COMMS_THUMBNAIL_BACKFILL_CHUNK,
              );
              if (out.processed > 0) {
                return {
                  processed: out.processed,
                  perKey: { thumbnailed: out.thumbnailed, skipped: out.skipped },
                };
              }
              return { processed: 0 };
            },
          ),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ──────── Task #2390: bulk reformat Common Issues on ALL reports ────────
// Re-runs EVERY Intake/Sales Common Issues section through the shared Task
// #2389 formatter (`formatCommonIssuesContent`) so the whole back catalog is
// retroactively reformatted — including sections that already look formatted
// (a newer prompt pass may improve them). Shares its candidate-selection +
// processing core verbatim with `scripts/backfill-common-issues-reformat.ts`
// via `commonIssuesReformatBackfill.ts`. One-and-done: a single press starts a
// worker-pool background drain that formats a few sections per chunk and
// stamps each with `data.commonIssuesReformatBackfillVersion` until no
// unstamped candidate remains. No external breaker needed — the formatter
// never throws (degrades to a deterministic fallback on AI failure).
const COMMON_ISSUES_REFORMAT_CHUNK = 5;

const COMMON_ISSUES_REFORMAT_DELAY_MS = 250;


// Plain-English completion summary for the History panel + in-progress line.
function formatCommonIssuesReformatSummary(state: DrainState): string {
  const k = state.perKey ?? {};
  const changed = k.changed ?? 0;
  const degraded = k.degraded ?? 0;
  const structureRepaired = k.structureRepaired ?? 0;
  const head =
    `${state.processed} of ${state.totalAtStart} Intake/Sales section(s) reformatted` +
    ` — ${changed} changed`;
  const degradeNote =
    degraded > 0 ? `; ${degraded} used the deterministic fallback (AI unavailable)` : "";
  // Task #3770 — malformed single-line rows repaired by re-inserting line
  // structure (no AI pass); surfaced so the operator can see how many
  // wall-of-text rows the press actually fixed.
  const repairNote =
    structureRepaired > 0
      ? `; ${structureRepaired} single-line structure repair(s) (no AI)`
      : "";
  return `${head}${degradeNote}${repairNote}.`;
}


export const reformatCommonIssuesAllReportsAction: ProdAction = {
  id: "reformat_common_issues_all_reports",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot reformat migration across historical reports — an operator-reviewed rewrite of published report content; new reports already render the current format.",
  },
  title: "Reformat Common Issues on ALL reports (Task #2390)",
  description:
    "Retroactively reformats EVERY report's Intake & Sales Common Issues through the shared Task #2389 formatter (`formatCommonIssuesContent` → 🔴 Issue / ↳ Impact / ➡️ Strategic Fix, with OCR-artifact cleanup) so the whole back catalog matches the clean format new imports get — including sections that already look formatted, since a newer prompt pass may improve them. One-and-done: a single press starts a worker-pool background drain that formats " +
    String(COMMON_ISSUES_REFORMAT_CHUNK) +
    " section(s) per chunk and stamps each with the current backfill version until no unstamped candidate remains. Empty / 'missing data source' placeholder sections are left untouched. Task #3770: sections stored as a malformed single-line wall of text (canonical 🔴/↳/➡️ markers but no line breaks — e.g. the shared Ackah Law 2026-07 Intake section) are revived as candidates even though already stamped, and repaired deterministically by re-inserting line structure (no AI pass). Idempotent / convergent: stamped sections fall out of the candidate set (repaired single-line rows gain line breaks and stop matching the revival), so the action settles to 'not needed' after one pass (no AI re-billing of the whole catalog). Degrades safely — the formatter never throws.",
  change:
    "Background-drain UPDATE of report_sections.data.commonIssues for section_key IN ('intake','sales') with a non-empty, non-placeholder body, running each through formatCommonIssuesContent and stamping data.commonIssuesReformatBackfillVersion, " +
    String(COMMON_ISSUES_REFORMAT_CHUNK) +
    " sections/chunk on the worker pool. Task #3770: stamped rows whose stored text is single-line with canonical markers are re-selected and rewritten via the deterministic structure normalizer instead of an AI call. Placeholder/empty sections are skipped (never written, never block convergence).",
  async status() {
    if (isDrainRunning("reformat_common_issues_all_reports")) {
      const s = getDrainState("reformat_common_issues_all_reports")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-reformat-common-issues-count",
      () => findReformatCandidateSections(getDb()),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail: `No Intake/Sales Common Issues sections need reformatting (every non-placeholder section is stamped at version ${COMMON_ISSUES_REFORMAT_BACKFILL_VERSION}).`,
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} Intake/Sales Common Issues section(s) would be reformatted via background drain (${COMMON_ISSUES_REFORMAT_CHUNK} per chunk).`,
    };
  },
  async apply(actorId) {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const out = await startBackgroundDrain(
      {
        actionId: "reformat_common_issues_all_reports",
        actionTitle: "Reformat Common Issues on ALL reports",
        attributionLabel: "maintenance:prod-actions-reformat-common-issues",
        unit: "section(s)",
        formatSummary: formatCommonIssuesReformatSummary,
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-reformat-common-issues-count",
            () => findReformatCandidateSections(getDb()),
          );
          return candidates.length;
        },
        runChunk: async () => {
          // getDb() here resolves to the worker pool (runDrainLoop wraps the
          // loop in runWithWorkerDb). Re-query each chunk: processed sections
          // are stamped and fall out, so the candidate set shrinks naturally;
          // placeholder sections are never returned and never block this.
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-reformat-common-issues-count",
            () => findReformatCandidateSections(getDb()),
          );
          const chunk = candidates.slice(0, COMMON_ISSUES_REFORMAT_CHUNK);
          if (chunk.length === 0) return { processed: 0 };

          let processed = 0;
          let changed = 0;
          let degraded = 0;
          let placeholderSkipped = 0;
          let structureRepaired = 0;
          for (const cand of chunk) {
            const res = await withDbAttribution(
              "maintenance:prod-actions-reformat-common-issues-apply",
              () => processReformatSection({ db: getDb(), apply: true }, cand),
            );
            if (res.kind === "skipped_placeholder") {
              placeholderSkipped++;
              continue;
            }
            processed++;
            if (res.changed) changed++;
            if (res.degraded) degraded++;
            if (res.structureRepaired) structureRepaired++;
            if (COMMON_ISSUES_REFORMAT_DELAY_MS) {
              await sleep(COMMON_ISSUES_REFORMAT_DELAY_MS);
            }
          }
          return {
            processed,
            perKey: {
              changed,
              ...(degraded > 0 ? { degraded } : {}),
              ...(placeholderSkipped > 0 ? { placeholderSkipped } : {}),
              ...(structureRepaired > 0 ? { structureRepaired } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #4543: repair degenerate Common Issues in pre-gate FINAL reports ───
//
// The Task #4227 finalize gate protects every report finalized after it
// merged (2026-08-10), but reports already status='final' keep their stored
// degenerate copy forever — the January 2026 final deck (and its PDF) still
// shows "Issue: Being Bad" via its client share link. This action re-runs the
// gate's exact detector (`findDegenerateCommonIssues`) over historical final
// reports created BEFORE the gate shipped and surgically repairs failing
// sections: only a thin **Issue:**/**Impact:** body is replaced (AI
// restatement grounded strictly in that block's own Impact/Strategic Fix
// text), marker-only truncation residue is dropped, and every healthy line is
// reassembled byte-identical. A repaired section must pass the detector or
// its content is left untouched and reported for operator follow-up.
// Post-gate reports are structurally excluded (created_at cutoff), so a
// report an operator explicitly confirmed past the gate is never overridden.
// Convergent: every processed section (repaired OR unrepairable) is stamped
// `data.degenerateCopyRepairVersion` and falls out of the candidate set.
const DEGENERATE_COPY_REPAIR_ID = "repair_degenerate_common_issues_final_reports";
const DEGENERATE_COPY_REPAIR_CHUNK = 3;
const DEGENERATE_COPY_REPAIR_DELAY_MS = 250;


function formatDegenerateCopyRepairSummary(state: DrainState): string {
  const k = state.perKey ?? {};
  const head =
    `${state.processed} of ${state.totalAtStart} degenerate Common Issues ` +
    `section(s) processed — ${k.repaired ?? 0} repaired`;
  const unrepaired =
    (k.unrepaired ?? 0) > 0
      ? `; ${k.unrepaired} could not be auto-repaired (left untouched — needs an operator edit; see logs for report/section)`
      : "";
  const conflicts =
    (k.skippedConflict ?? 0) > 0
      ? `; ${k.skippedConflict} skipped (edited mid-run; re-selected next press)`
      : "";
  return `${head}${unrepaired}${conflicts}.`;
}


export const repairDegenerateCommonIssuesFinalReportsAction: ProdAction = {
  id: DEGENERATE_COPY_REPAIR_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot repair of a historical content-corruption class — an operator reviews the affected final reports before their published content is rewritten.",
  },
  title:
    "Repair degenerate Common Issues copy in pre-gate FINAL reports (Task #4543)",
  description:
    "One-off backfill for reports finalized BEFORE the Task #4227 finalize-time quality gate shipped (2026-08-10): re-runs the gate's exact degenerate-copy detector over every status='final' report's stored Intake & Sales Common Issues and surgically repairs failing sections — e.g. the January 2026 final deck still serving \"Issue: Being Bad\" to its client share link. Only the thin **Issue:**/**Impact:** body is replaced, via an AI restatement grounded strictly in that block's own Impact/Strategic Fix text (no invented facts); marker-only truncation residue blocks are dropped; every healthy line is kept byte-identical. A repaired section must pass the gate detector or its content is left untouched and reported for operator follow-up. Reports created after the gate shipped are structurally excluded, so an explicitly operator-confirmed post-gate finalization is never overridden; rows edited mid-run are skipped (the operator's edit wins). One-and-done / convergent: every processed section is stamped data.degenerateCopyRepairVersion (version " +
    String(DEGENERATE_COPY_REPAIR_VERSION) +
    ") and falls out of the candidate set, so the action settles to 'not needed' after one pass.",
  change:
    "Background-drain UPDATE of report_sections.data.commonIssues (other keys preserved) for section_key IN ('intake','sales') rows of final, pre-2026-08-10 reports whose stored copy fails findDegenerateCommonIssues, " +
    String(DEGENERATE_COPY_REPAIR_CHUNK) +
    " section(s)/chunk on the worker pool, stamping data.degenerateCopyRepairVersion on every processed row.",
  async status() {
    if (isDrainRunning(DEGENERATE_COPY_REPAIR_ID)) {
      const s = getDrainState(DEGENERATE_COPY_REPAIR_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-degenerate-copy-repair-count",
      () => findDegenerateFinalReportSections(getDb()),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail:
          "No pre-gate FINAL report carries degenerate Common Issues copy (every failing section is repaired or stamped for operator follow-up).",
      };
    }
    const preview = candidates
      .slice(0, 5)
      .map(
        (c) =>
          `${c.reportMonth} ${c.sectionKey} (${c.snippets
            .slice(0, 2)
            .map((s) => JSON.stringify(s))
            .join(", ")})`,
      )
      .join("; ");
    return {
      state: "pending",
      detail: `${candidates.length} stored Common Issues section(s) in pre-gate FINAL reports fail the quality detector — e.g. ${preview}. A single press repairs them via background drain (${DEGENERATE_COPY_REPAIR_CHUNK} per chunk).`,
    };
  },
  async apply(actorId) {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Rows whose atomic CAS write lost to a mid-run operator edit. They are
    // excluded from every later chunk of THIS run (never retried against the
    // operator's fresh edit); if the edit still fails the detector they
    // re-enter selection on the next press.
    const conflicted = new Set<string>();
    const out = await startBackgroundDrain(
      {
        actionId: DEGENERATE_COPY_REPAIR_ID,
        actionTitle: "Repair degenerate Common Issues copy in pre-gate FINAL reports",
        attributionLabel: "maintenance:prod-actions-degenerate-copy-repair",
        unit: "section(s)",
        formatSummary: formatDegenerateCopyRepairSummary,
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-degenerate-copy-repair-count",
            () => findDegenerateFinalReportSections(getDb()),
          );
          return candidates.length;
        },
        runChunk: async () => {
          // Re-query each chunk: processed sections are stamped and fall out.
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-degenerate-copy-repair-count",
            () => findDegenerateFinalReportSections(getDb()),
          );
          const chunk = candidates
            .filter((c) => !conflicted.has(c.id))
            .slice(0, DEGENERATE_COPY_REPAIR_CHUNK);
          if (chunk.length === 0) return { processed: 0 };

          let processed = 0;
          let repaired = 0;
          let unrepaired = 0;
          let skippedConflict = 0;
          for (const cand of chunk) {
            // The AI rewrite inside runs OUTSIDE any DB hold; only the short
            // re-read + UPDATE touch the pool.
            const res = await withDbAttribution(
              "maintenance:prod-actions-degenerate-copy-repair-apply",
              () => processDegenerateRepairSection(getDb(), cand),
            );
            // Audit trail: name every touched report/section and outcome.
            console.log(
              `[degenerate-copy-repair] report=${cand.reportId} month=${cand.reportMonth} section=${cand.sectionKey} outcome=${res.kind}` +
                (res.kind === "unrepaired" ? ` reasons=${JSON.stringify(res.reasons)}` : ""),
            );
            if (res.kind === "skipped_conflict") {
              conflicted.add(cand.id);
              skippedConflict++;
              continue;
            }
            processed++;
            if (res.kind === "repaired") repaired++;
            else unrepaired++;
            if (DEGENERATE_COPY_REPAIR_DELAY_MS) {
              await sleep(DEGENERATE_COPY_REPAIR_DELAY_MS);
            }
          }
          // Conflicted rows are NOT counted as processed — they were not
          // touched. The drain ends once only conflicted rows remain.
          return {
            processed,
            perKey: {
              repaired,
              ...(unrepaired > 0 ? { unrepaired } : {}),
              ...(skippedConflict > 0 ? { skippedConflict } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


export const clearPlaceholderCommonIssuesAction: ProdAction = {
  id: "clear_placeholder_common_issues",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot cleanup of placeholder content on historical reports — rewriting published report content is an operator-reviewed step.",
  },
  title: "Clear placeholder 'Missing data source' Common Issues on ALL reports (Task #3769/#3901)",
  description:
    "Scans every report's Intake & Sales Common Issues and blanks values that are placeholder-only — the literal 'Missing data source …' text (including trailing 'Name_Clean (N): <client>' source artifacts), blank/artifact-only bodies, and AI-rewritten placeholder findings (every 🔴 block derived from the placeholder). Task #3901 extends detection to the junk-fed classes: the multi-block shape where a leading 'Missing data source' 🔴 block is followed by findings the AI fabricated from swallowed dashboard junk ('Registrants count missing', 'Delayed data updates', … — e.g. Wanta Thome 2026-07's 11 fake blocks), mid-text 'Name_Clean (N)' remediation variants (MJ Law/Syverson 2026-06), and the raw literal placeholder with a swallowed-junk tail. Sections mixing genuinely real findings with placeholder text are left untouched (business-generic hallucinations indistinguishable from real prose deliberately stay visible), and each row is re-checked immediately before write so operator edits landing mid-run are never overwritten. Idempotent / convergent: cleared rows drop out of the candidate set, so the action settles to 'not needed' once no placeholder-derived value remains.",
  change:
    "UPDATE report_sections SET data.commonIssues = '' (other keys preserved) for section_key IN ('intake','sales') rows whose ENTIRE commonIssues value is placeholder-only per the shared pdfImportParser detectors. Runs synchronously on the worker pool; reports the number of rows cleared.",
  async status() {
    const scan = await withDbAttribution(
      "maintenance:prod-actions-clear-placeholder-issues-count",
      () => scanPlaceholderCommonIssues(getDb()),
    );
    if (scan.candidates.length === 0) {
      return {
        state: "not-needed",
        detail: `No placeholder-only Common Issues values remain (${scan.scanned} intake/sales section(s) scanned; ${scan.skippedRealContent} with real content left untouched).`,
      };
    }
    const k = scan.countsByKind;
    return {
      state: "pending",
      detail: `${scan.candidates.length} stored Common Issues value(s) are placeholder-derived and would be cleared (literal=${k.literal_placeholder}, blank=${k.blank_body}, ai_rewritten=${k.ai_rewritten_placeholder}, junk_fabricated=${k.junk_fabricated_placeholder}, junk_tailed_literal=${k.junk_tailed_literal}).`,
    };
  },
  async apply() {
    const scan = await withDbAttribution(
      "maintenance:prod-actions-clear-placeholder-issues-count",
      () => scanPlaceholderCommonIssues(getDb()),
    );
    if (scan.candidates.length === 0) {
      return {
        state: "not-needed",
        detail: `No placeholder-only Common Issues values remain (${scan.scanned} intake/sales section(s) scanned).`,
      };
    }
    const cleared = await withDbAttribution(
      "maintenance:prod-actions-clear-placeholder-issues-apply",
      () => clearPlaceholderCommonIssuesCandidates(getDb(), scan.candidates),
    );
    const k = scan.countsByKind;
    return {
      state: "applied",
      detail: `Cleared ${cleared} placeholder-derived Common Issues value(s) across reports (literal=${k.literal_placeholder}, blank=${k.blank_body}, ai_rewritten=${k.ai_rewritten_placeholder}, junk_fabricated=${k.junk_fabricated_placeholder}, junk_tailed_literal=${k.junk_tailed_literal}). Affected reports now show 'No issues identified' instead of the fake finding.`,
      rowsAffected: cleared,
    };
  },
};

const JUNE_LEAD_REPARSE_CHUNK = 3;


function formatJuneLeadReparseSummary(state: DrainState): string {
  const k = state.perKey ?? {};
  return (
    `${state.processed} of ${state.totalAtStart} June 2026 report(s) re-parsed — ` +
    `${k.corrected ?? 0} corrected, ${k.unchanged ?? 0} unchanged, ` +
    `${k.skippedNoSource ?? 0} skipped (no source PDF)` +
    ((k.errors ?? 0) > 0 ? `, ${k.errors} failed (stamped; see logs)` : "") +
    `.`
  );
}


export const reparseJune2026ReportLeadsAction: ProdAction = {
  id: "reparse_june_2026_report_leads",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot reparse of a specific month's lead rows — an operator confirms the parser fix applies to the affected imports before stored report data is rewritten.",
  },
  title: "Re-parse June 2026 report lead counts from source PDFs (Task #2753)",
  description:
    "Re-parses EVERY June 2026 (reportMonth='2026-06') report from its saved source PDF through the fixed Total-Leads reconciliation parser (Task #2753) — the old parser let a mis-read tiny 'Total Leads' (e.g. 1) clamp every well-supported per-source lead count down to the bad total. One press starts a worker-pool background drain that loads each report's saved PDF (fallback: the original webhook source URL), re-parses, applies the active-products filter, and surgically merges ONLY the lead fields (total, per-source unique leads, lead quality, recomputed cost-per-lead, quality rollups) onto the existing marketing section via the audited section writer. Reports whose freshly-parsed leads already match are stamped 'unchanged' (no write beyond the stamp); reports with no available source are stamped and clearly reported as skipped. One-and-done / convergent: every outcome stamps data.juneLeadReparseVersion, so the action settles to 'not needed' after one pass.",
  change:
    "Background-drain re-parse of all reportMonth='2026-06' reports (" +
    String(JUNE_LEAD_REPARSE_CHUNK) +
    " per chunk, worker pool): saved source PDF → fixed parser → active-products filter → surgical lead-field merge onto report_sections(marketing) via upsertReportSection (edit-audit trail preserved), stamping juneLeadReparseVersion + juneLeadReparseOutcome (corrected / unchanged / skipped_no_source / error) on every report.",
  async status() {
    if (isDrainRunning("reparse_june_2026_report_leads")) {
      const s = getDrainState("reparse_june_2026_report_leads")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { findJuneReparseCandidates } = await import("../juneLeadReparse");
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-june-lead-reparse-count",
      () => findJuneReparseCandidates(getDb()),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail:
          "Every June 2026 report is stamped at the current re-parse version (corrected / unchanged / skipped-no-source outcomes recorded on each marketing section).",
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} June 2026 report(s) would be re-parsed from their saved source PDFs via background drain (${JUNE_LEAD_REPARSE_CHUNK} per chunk).`,
    };
  },
  async apply(actorId) {
    const {
      findJuneReparseCandidates,
      processJuneReparseReport,
      buildProdJuneReparseDeps,
    } = await import("../juneLeadReparse");
    const out = await startBackgroundDrain(
      {
        actionId: "reparse_june_2026_report_leads",
        actionTitle: "Re-parse June 2026 report lead counts",
        attributionLabel: "maintenance:prod-actions-june-lead-reparse",
        unit: "report(s)",
        formatSummary: formatJuneLeadReparseSummary,
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-june-lead-reparse-count",
            () => findJuneReparseCandidates(getDb()),
          );
          return candidates.length;
        },
        runChunk: async () => {
          // getDb() resolves to the worker pool here (runDrainLoop wraps the
          // loop in runWithWorkerDb). Processed reports are stamped and fall
          // out of the candidate set, so re-querying each chunk converges.
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-june-lead-reparse-count",
            () => findJuneReparseCandidates(getDb()),
          );
          const chunk = candidates.slice(0, JUNE_LEAD_REPARSE_CHUNK);
          if (chunk.length === 0) return { processed: 0 };

          const deps = await withDbAttribution(
            "maintenance:prod-actions-june-lead-reparse-apply",
            () => buildProdJuneReparseDeps(getDb(), actorId ?? null),
          );
          let corrected = 0;
          let unchanged = 0;
          let skippedNoSource = 0;
          let errors = 0;
          for (const cand of chunk) {
            // PDF load + parse are external/CPU work; the audited section
            // write inside processJuneReparseReport re-enters the DB only
            // for the short upsert transaction (DB Hold Rules).
            const res = await processJuneReparseReport(deps, cand);
            if (res.outcome === "corrected") corrected++;
            else if (res.outcome === "unchanged") unchanged++;
            else if (res.outcome === "skipped_no_source") skippedNoSource++;
            else errors++;
          }
          return {
            processed: chunk.length,
            perKey: {
              corrected,
              unchanged,
              ...(skippedNoSource > 0 ? { skippedNoSource } : {}),
              ...(errors > 0 ? { errors } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #2843 — Review webinar breakdown ↔ Hot Transfers mismatches ─
//
// The "stale breakdown" class behind the Kevin / report 3063e933 bug: the
// import-seeded `webinar.leadQuality` breakdown keeps driving every derived
// lead total (breakdown-sum-first priority rule) after the operator edits
// Hot Transfers, because editing Hot Transfers never touched the breakdown.
// Task #2839 shipped the actual correction surface — editable breakdown
// inputs + an inline mismatch warning on the report editor's Webinars card —
// but only an operator can decide the correct values, so this action NEVER
// mutates report data. `status()` surfaces every currently-mismatched report
// (same predicate as the editor's warning); `apply()` records the surfaced
// list as acknowledged (one durable `system_settings` write) so the action
// converges after a single press. Signatures encode the exact mismatched
// values, so fixing a report in the editor clears it entirely, while any NEW
// mismatch (or the same report drifting again) automatically returns the
// action to pending with only the new items listed.
export const reviewWebinarBreakdownMismatchesAction: ProdAction = {
  id: "review_webinar_breakdown_mismatches",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "A review action by design: deciding which source is right for each webinar-breakdown mismatch is human judgment — auto-firing a review is meaningless.",
  },
  title: "Review webinar lead-breakdown ↔ Hot Transfers mismatches (Task #2843)",
  description:
    "Finds every report (active, non-demo clients owning the webinar product) whose stored webinar lead-quality breakdown sum is > 0 and differs from Hot Transfers — the stale-breakdown state where the breakdown silently drives all displayed lead totals at the old value. The list names each report with a direct /reports/{id} link; the correction itself is an operator judgment made in the report editor's Webinars card (Task #2839 inputs): set the breakdown to the intended split, or zero it out to fall back to Hot Transfers × 1.6. One press acknowledges the current list (recorded in system_settings.webinar_breakdown_mismatch_review_ack) so the action settles; a report edited to agreement drops out entirely, and any new or re-drifted mismatch re-surfaces on its own.",
  change:
    "Read-only scan of report_sections(marketing) joined to reports + clients; apply writes the acknowledged mismatch signatures to system_settings.webinar_breakdown_mismatch_review_ack. Report data is never modified.",
  async status() {
    const {
      findWebinarBreakdownMismatches,
      parseAckSignatures,
      mismatchSignature,
      formatMismatchLine,
      WEBINAR_MISMATCH_ACK_SETTING,
    } = await import("../webinarBreakdownMismatchReview");
    const mismatches = await withDbAttribution(
      "maintenance:prod-actions-webinar-breakdown-review",
      () => findWebinarBreakdownMismatches(getDb()),
    );
    if (mismatches.length === 0) {
      return {
        state: "not-needed",
        detail:
          "No report has a webinar lead-quality breakdown disagreeing with Hot Transfers (active webinar clients).",
      };
    }
    const ackRow = await storage.getSystemSettingFresh(WEBINAR_MISMATCH_ACK_SETTING);
    const acked = parseAckSignatures(ackRow?.value);
    const unacked = mismatches.filter((m) => !acked.has(mismatchSignature(m)));
    if (unacked.length === 0) {
      return {
        state: "applied",
        detail: `All ${mismatches.length} current mismatch(es) acknowledged for review — correct each via the report editor's Webinars card (breakdown inputs), after which it drops off this list: ${mismatches
          .map(formatMismatchLine)
          .join("; ")}`,
      };
    }
    return {
      state: "pending",
      detail: `${unacked.length} report(s) need review — the webinar breakdown sum drives displayed lead totals and disagrees with Hot Transfers. Fix in the report editor's Webinars card (set the breakdown to the intended split, or zero it to fall back to Hot Transfers): ${unacked
        .map(formatMismatchLine)
        .join("; ")}`,
    };
  },
  async apply(actorId) {
    const {
      findWebinarBreakdownMismatches,
      serializeAckSignatures,
      formatMismatchLine,
      WEBINAR_MISMATCH_ACK_SETTING,
    } = await import("../webinarBreakdownMismatchReview");
    const mismatches = await withDbAttribution(
      "maintenance:prod-actions-webinar-breakdown-review",
      () => findWebinarBreakdownMismatches(getDb()),
    );
    if (mismatches.length === 0) {
      // Keep the ack setting from carrying stale signatures forever once
      // everything is fixed.
      await storage.deleteSystemSetting(WEBINAR_MISMATCH_ACK_SETTING);
      return {
        state: "not-needed",
        detail:
          "No webinar breakdown mismatches exist — nothing to acknowledge (any previous acknowledgment record was cleared).",
      };
    }
    await storage.setSystemSetting(
      WEBINAR_MISMATCH_ACK_SETTING,
      serializeAckSignatures(mismatches),
      actorId ?? undefined,
    );
    return {
      state: "applied",
      detail: `Acknowledged ${mismatches.length} mismatch(es) for operator review — correct each in the report editor's Webinars card (breakdown inputs shipped by Task #2839): ${mismatches
        .map(formatMismatchLine)
        .join("; ")}`,
      rowsAffected: mismatches.length,
    };
  },
};


/**
 * Task #3772 (extension) — retroactive heal for the fabricated unflagged
 * zeros that pre-fix PDF webhook imports wrote into entry-tracked
 * intake/sales sections. Full mechanics + safety rails documented in
 * `server/services/importedZeroHealer.ts`. One press heals every report:
 * fields whose stored PDF text now re-parses (e.g. the "Time to Human
 * Answer" label) get the real value; the rest get their No-Data flag set
 * so the public report renders "No Data" instead of "0s · Healthy".
 * Operator-edited and evidence-backed fields are never touched.
 */
export const healImportedFabricatedZeroMetricsAction: ProdAction = {
  id: "heal_imported_fabricated_zero_metrics",
  convergence: { kind: "converging" },
  // Task #4762 — self-drains: skips operator-edited fields and genuine
  // parsed zeros by construction, re-parses only stored PDF text (no
  // vendor calls), and section history records every write. Safe to
  // auto-fire; 6h cadence matches the other one-shot mop-ups.
  selfHeal: { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
  title: "Heal fabricated zeros on imported reports",
  description:
    "Pre-#3772 PDF imports wrote 0 for every metric the parser missed (no No-Data flag), and a later form-save converted those into 'entered' healthy zeros on the public report (e.g. Ackah Law 2026-07 Avg Time to Human Answer). This heals all past webhook-imported reports: re-parses each report's stored PDF text with the current parser to fill real values where possible, flags the rest No-Data. Skips any field an operator edited and any genuine parsed zero.",
  change:
    "For webhook-imported intake/sales sections, updates fields whose value is an unbacked 0/absent and whose flag is not already No-Data: writes the re-parsed value (flag=false) when the stored PDF text yields one, otherwise sets the No-Data flag. Section history rows record every write (editor system:import-zero-heal).",
  status: async () => {
    const { runImportedZeroHeal } = await import("../importedZeroHealer");
    const plan = await runImportedZeroHeal({ dryRun: true, reparse: false });
    if (plan.pendingFields === 0) {
      const dirtyNote =
        plan.skippedDirty.length > 0
          ? ` ${plan.skippedDirty.length} operator-edited field(s) were left alone by design.`
          : "";
      return {
        state: "not-needed",
        detail: `No unbacked zero-metrics remain across ${plan.sectionsScanned} imported section(s).${dirtyNote}`,
      };
    }
    const bySection = new Map<string, number>();
    for (const f of [...plan.filled, ...plan.flagged]) {
      const key = `${f.sectionKey}.${f.field}`;
      bySection.set(key, (bySection.get(key) ?? 0) + 1);
    }
    const breakdown = [...bySection.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    return {
      state: "pending",
      detail: `${plan.pendingFields} unbacked zero-metric field(s) across ${plan.reportsScanned} imported report(s) need healing (top: ${breakdown}). Applying re-parses each report's stored PDF text with the current parser — fields it now finds (e.g. the "Time to Human Answer" label) get their real value; the rest get flagged No-Data so reports stop rendering fabricated healthy zeros.`,
    };
  },
  apply: async () => {
    const { runImportedZeroHeal } = await import("../importedZeroHealer");
    const result = await runImportedZeroHeal({ dryRun: false, reparse: true });
    if (result.pendingFields === 0) {
      return {
        state: "not-needed",
        detail: `Nothing to heal — no unbacked zero-metrics across ${result.sectionsScanned} imported section(s).`,
      };
    }
    const fillSamples = result.filled
      .slice(0, 8)
      .map((f) => `${f.clientName} ${f.reportMonth} ${f.sectionKey}.${f.field}=${f.value}`)
      .join("; ");
    const dirtyNote =
      result.skippedDirty.length > 0
        ? ` Skipped ${result.skippedDirty.length} operator-edited field(s) (their values stand; use the report's Reimport button if one needs the PDF value).`
        : "";
    return {
      state: "applied",
      rowsAffected: result.sectionsHealed,
      detail: `Healed ${result.pendingFields} field(s) across ${result.sectionsHealed} section(s): filled ${result.filled.length} real value(s) from re-parsed PDF text${
        result.filled.length > 0 ? ` (${fillSamples}${result.filled.length > 8 ? ", …" : ""})` : ""
      }, flagged ${result.flagged.length} as No-Data.${dirtyNote}`,
    };
  },
};


export const rejudgeStaleClientJudgmentsAction: ProdAction = {
  id: "rejudge_stale_client_judgments",
  convergence: { kind: "converging" },
  // Irreversible retention work must never ride Apply all or self-heal.
  manualLever: true,
  destructiveConfirmation: {
    phrase: FRESH_SLATE_DESTRUCTIVE_CONFIRMATION,
    warning:
      "This permanently deletes every superseded judgment for active clients. Inactive-client history is not touched, and deleted history cannot be restored from this panel.",
  },
  title: "Reset active client rating history",
  description:
    "First force-regenerates every active client's invalid or carried-forward latest rating and verifies the repaired rating contract across the whole portfolio. Only after that verifier passes, permanently deletes every older active-client judgment in one-client transactions, retaining exactly one self-contained current rating. Relationship signals tied to deleted judgments cascade, save plays are preserved with their deleted source link cleared, and concern intelligence is preserved. Inactive and demo-client history is never touched. One confirmed press starts a bounded, cross-instance-safe worker drain; final audit history records the actual rating distribution and dependent-record dispositions.",
  change:
    "IRREVERSIBLE: replace invalid/carried active-client ratings, verify the portfolio, then permanently delete superseded active-client judgment rows while retaining exactly one current repaired rating per client.",
  async status() {
    const { isDrainRunning, getDrainState } = await import(
      "../prodActionBackgroundDrain"
    );
    const {
      REJUDGE_STALE_JUDGMENTS_ACTION_ID,
      formatFreshSlateDrainSummary,
      getFreshSlateReadiness,
    } = await import(
      "../rejudgeStaleJudgments"
    );
    if (isDrainRunning(REJUDGE_STALE_JUDGMENTS_ACTION_ID)) {
      const s = getDrainState(REJUDGE_STALE_JUDGMENTS_ACTION_ID)!;
      return {
        state: "not-needed",
        detail: `Fresh-slate operation is running on this instance — ${formatFreshSlateDrainSummary(s)}. History removal starts only after replacement verification passes.`,
      };
    }
    const { isProdActionDrainLockHeld } = await import("../crossInstanceLock");
    if (await isProdActionDrainLockHeld(REJUDGE_STALE_JUDGMENTS_ACTION_ID)) {
      return {
        state: "not-needed",
        detail:
          "Fresh-slate operation is running on another instance. A duplicate press is a safe no-op; terminal generation, deletion, and portfolio-verification totals will land in History.",
      };
    }
    const readiness = await getFreshSlateReadiness();
    if (readiness.state === "settled") {
      const portfolio = readiness.verification.portfolio;
      return {
        state: "not-needed",
        detail:
          `Settled and verified at ${readiness.verification.checkedAt}: exactly one repaired, self-contained rating for each of ${portfolio.activeAccounts} active client(s). ` +
          `Distribution: Healthy ${portfolio.statusCounts.Healthy}, Watch ${portfolio.statusCounts.Watch}, At Risk ${portfolio.statusCounts["At Risk"]}, Critical ${portfolio.statusCounts.Critical}.`,
      };
    }
    if (readiness.state === "blocked") {
      return { state: "not-needed", detail: readiness.detail };
    }
    return {
      state: "not-needed",
      detail:
        `Ready for explicit CEO confirmation: ${readiness.replacementClients} active client rating(s) require a verified replacement, then ${readiness.cleanupClients} client(s) have superseded history to permanently remove. No deletion starts before the portfolio verifier passes.`,
    };
  },
  async apply(actorId, input) {
    if (input?.confirmation !== FRESH_SLATE_DESTRUCTIVE_CONFIRMATION) {
      return {
        state: "blocked",
        detail:
          `Destructive confirmation required. Type exactly: ${FRESH_SLATE_DESTRUCTIVE_CONFIRMATION}`,
      };
    }
    const { startActiveRatingFreshSlateDrain } = await import(
      "../rejudgeStaleJudgments"
    );
    const out = await startActiveRatingFreshSlateDrain(actorId ?? null);
    if (out.state === "blocked") {
      return { state: "blocked", detail: out.detail };
    }
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


export const deactivateFabricatedZeroMetricFactsAction: ProdAction = {
  id: "deactivate_fabricated_zero_metric_facts",
  // Each drained client's poisoned rows flip is_active=false, permanently
  // shrinking the pending set; the Task #4846 extraction guard blocks new
  // judgments from re-persisting (or resurrecting) the same claims, so the
  // set cannot re-fill.
  convergence: { kind: "converging" },
  humanGate: {
    reason:
      "Reviewed one-shot memory repair: deactivating agent-memory rows changes what the judgment agent remembers about ~55 clients at once, and the intended rollout is a deliberate operator sequence (press this, then Re-judge stale client judgments). Auto-firing on a schedule could also mask a predicate regression by silently reaping freshly-written facts instead of surfacing them for review.",
  },
  title: "Deactivate fabricated zero-metric memory facts",
  description:
    "The daily-judgment agent spent months asserting '0 intake / 0 sales' narratives for clients who structurally never report those metrics (intake totalConsults / sales totalCases No-Data-flagged in every report month). Each judgment re-persisted those claims as agent-memory facts, which re-entered the next day's prompt as top-scored recurring concerns — a self-reinforcing loop (verified in prod 2026-08-17: ~1.5k active poisoned rows across ~55 clients; Ashley Andrews Law alone had 59, restated daily since March). This deactivates (never deletes) every active daily_judgment-sourced fact asserting a zero/failed-conversion outcome for a metric family the client has NEVER entered — clients who genuinely track those metrics keep their zero claims (for them a zero may be a real measurement). One press starts a worker-pool background drain, one client's rows per chunk via a single atomic UPDATE; convergent and idempotent (already-inactive rows are untouched). After this converges, press 'Re-judge stale client judgments' so regenerated judgments start from clean memory.",
  change:
    "Background-drain on the worker pool: UPDATE agent_knowledge_base SET is_active=false, updated_at=now() for active source_agent='daily_judgment' rows whose fact_text matches the calibrated fabricated-zero predicate AND whose client's report history shows every asserted metric family was never entered (shared/judgmentMetricTracking classification — same predicate the extraction guard uses).",
  async status() {
    const { isDrainRunning, getDrainState } = await import(
      "../prodActionBackgroundDrain"
    );
    const {
      FABRICATED_ZERO_FACTS_ACTION_ID,
      countFabricatedZeroFactsPending,
      formatFabricatedZeroDrainSummary,
    } = await import("../judgmentMemoryHygiene");
    if (isDrainRunning(FABRICATED_ZERO_FACTS_ACTION_ID)) {
      const s = getDrainState(FABRICATED_ZERO_FACTS_ACTION_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatFabricatedZeroDrainSummary(s)}.`,
      };
    }
    // Autoscale: the drain's in-memory state lives on whichever instance won
    // the press; the cross-instance advisory lock is the cluster-wide truth
    // (probe read-only — never pg_try_advisory_lock, that could steal a
    // real press).
    const { isProdActionDrainLockHeld } = await import("../crossInstanceLock");
    if (await isProdActionDrainLockHeld(FABRICATED_ZERO_FACTS_ACTION_ID)) {
      return {
        state: "pending",
        working: true,
        detail:
          "Background drain in progress on another instance — poisoned memory facts are being deactivated client by client. Progress lands in History when the drain finishes; this count shrinks as each client's rows flip inactive.",
      };
    }
    const counts = await countFabricatedZeroFactsPending();
    if (counts.facts === 0) {
      return {
        state: "not-needed",
        detail:
          "No active fabricated zero-metric facts remain — every daily_judgment-sourced memory row asserting a zero/failed-conversion outcome for a never-tracked metric family has been deactivated (and the extraction guard blocks new ones at the source).",
      };
    }
    return {
      state: "pending",
      detail: `${counts.facts} active poisoned memory fact(s) across ${counts.clients} client(s) assert zero/failed-conversion outcomes for intake/sales metric families those clients have never entered in any report month. One press starts a worker-pool background drain that deactivates them client by client (never deletes; tracked clients' zero claims are kept). Press 'Re-judge stale client judgments' afterwards so regenerated judgments start from clean memory.`,
    };
  },
  async apply(actorId) {
    const { startFabricatedZeroFactsDrain } = await import("../judgmentMemoryHygiene");
    const out = await startFabricatedZeroFactsDrain(actorId ?? null);
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #4175 — report data historical hygiene (F3 closure) ────────
//
// Audited replacements for the three retained-but-never-run F3 one-off
// scripts (audits/f3-operational-script-disposition-2026-08-09.md §3/§4/§6;
// scripts deleted in Task #4175 — git history is the archive). Logic lives
// in `server/services/reportHistoricalHygiene.ts`.

export const backfillEmptyReportSectionsAction: ProdAction = {
  id: "backfill_empty_report_sections",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot backfill of empty sections on historical reports — operator-reviewed content generation; new reports write their sections at finalize.",
  },
  title: "Backfill missing canonical report section rows (2026-05-13 fix backlog)",
  description:
    "Closes the measured F3 gap: 143 reports created before the 2026-05-13 " +
    "report-creation fix still lack one or more of the four canonical " +
    "report_sections rows (intake/sales/marketing/nextActions), so those " +
    "tabs render blank until someone saves them. One press inserts every " +
    "missing row as an empty section attributed to " +
    "'system:backfill_empty_sections' (migration_seed), each with a matching " +
    "baseline report_section_history entry so the edit-history dialog is " +
    "never empty for backfilled rows. Additive + idempotent: inserts use ON " +
    "CONFLICT DO NOTHING, so a concurrent real save always wins and a second " +
    "press is a no-op. Converging — the runtime create path has seeded all " +
    "four keys since 2026-05-13, so fresh pending later is a genuine incident.",
  change:
    "INSERT missing report_sections rows (data={}, lastEditedBy=" +
    "system:backfill_empty_sections, lastEditSource=migration_seed) with ON " +
    "CONFLICT DO NOTHING + one baseline report_section_history row per " +
    "inserted section.",
  async status() {
    const scan = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-empty-sections-count",
      async () => {
        const { scanMissingCanonicalSections } = await import(
          "../reportHistoricalHygiene"
        );
        return scanMissingCanonicalSections(getDb());
      },
    );
    if (scan.missingByReport.size === 0) {
      return {
        state: "not-needed",
        detail: `All ${scan.totalReports} report(s) have the four canonical section rows.`,
      };
    }
    return {
      state: "pending",
      detail:
        `${scan.missingByReport.size} report(s) lack ${scan.missingRowCount} canonical ` +
        `section row(s) (of ${scan.totalReports} reports) — tabs render blank until backfilled.`,
    };
  },
  async apply() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-empty-sections-apply",
      async () => {
        const { applyEmptySectionBackfill } = await import(
          "../reportHistoricalHygiene"
        );
        return applyEmptySectionBackfill(getDb());
      },
    );
    if (result.inserted === 0 && result.skippedExisting === 0) {
      return {
        state: "not-needed",
        detail: "No report is missing a canonical section row.",
      };
    }
    return {
      state: "applied",
      detail:
        `Inserted ${result.inserted} empty section row(s) (each with a baseline ` +
        `edit-history entry)` +
        (result.skippedExisting > 0
          ? `; ${result.skippedExisting} row(s) skipped — a concurrent save created them first.`
          : "."),
      rowsAffected: result.inserted,
    };
  },
};


export const backfillReportSectionHistoryAction: ProdAction = {
  id: "backfill_report_section_history_baseline",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot history-baseline seed for pre-audit-era sections — settled once applied; nothing routinely produces baseline-less sections anymore.",
  },
  title: "Seed baseline edit history for pre-#829 report sections",
  description:
    "Closes the measured F3 gap: 311 report sections last touched before " +
    "Task #829 shipped (2026-04-27) have zero report_section_history rows, " +
    "so their edit-history dialog is empty. One press inserts exactly one " +
    "baseline history entry per such section capturing its current data " +
    "snapshot, attributed to the report's webhook import log when one can be " +
    "found (direct id, else same client + report month), otherwise " +
    "unknown/migration_seed; the live row's NULL last_edited_* columns are " +
    "backfilled from the same attribution. Additive + idempotent: seeded " +
    "sections drop out of the no-history anti-join, and every save since " +
    "#829 writes history unconditionally, so the action settles after one " +
    "press. Run the empty-section backfill first — its inserts already carry " +
    "their own baseline history.",
  change:
    "INSERT one baseline report_section_history row per section with zero " +
    "history rows + UPDATE report_sections.last_edited_* via COALESCE " +
    "(NULL columns only).",
  async status() {
    const n = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-history-count",
      async () => {
        const { countSectionsWithoutHistory } = await import(
          "../reportHistoricalHygiene"
        );
        return countSectionsWithoutHistory(getDb());
      },
    );
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "Every report section has at least one edit-history entry.",
      };
    }
    return {
      state: "pending",
      detail: `${n} report section(s) have an empty edit-history dialog (no report_section_history rows).`,
    };
  },
  async apply() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-history-apply",
      async () => {
        const { applySectionHistorySeed } = await import(
          "../reportHistoricalHygiene"
        );
        return applySectionHistorySeed(getDb());
      },
    );
    if (result.seeded === 0) {
      return {
        state: "not-needed",
        detail: "No section is missing edit history.",
      };
    }
    return {
      state: "applied",
      detail:
        `Seeded ${result.seeded} baseline history entr(ies): ${result.attributed} ` +
        `attributed to a webhook import log, ${result.unknown} marked unknown/migration_seed.`,
      rowsAffected: result.seeded,
    };
  },
};


// Deliberately a MANUAL LEVER: unlike the two additive backfills above,
// this one REMOVES stored data (platform blocks for products the client
// doesn't own — Task #1028 residue), some of which may reflect later
// product churn rather than a never-run cleanup. Firing it must be a
// deliberate individual operator choice, not a side effect of a routine
// Apply-all pass. Every write goes through the audited section writer, so
// each cleaned section gains a report_section_history entry with the full
// previous payload — operator-reversible from the edit-history dialog.
export const cleanupInactiveProductReportBlocksAction: ProdAction = {
  id: "cleanup_inactive_product_report_blocks",
  convergence: { kind: "converging" },
  manualLever: true,
  title: "Manual lever: strip inactive-product blocks from stored marketing sections (Task #1028 residue)",
  description:
    "Applies the Task #1028 Active-Products gate to STORED historical " +
    "marketing sections (~150+ measured by F3): platform blocks (googleAds/" +
    "lsa/webinar/gbp) for products the client doesn't currently own are " +
    "removed from report_sections.data. Write-time filters stop new leakage " +
    "and the public read sanitizer already hides these blocks client-side; " +
    "this lever is the only batch path for the stored rows still visible in " +
    "internal report views. Uses the canonical resolver (command panel wins, " +
    "else clients.products); sections whose client resolves to NO products " +
    "are always skipped (an empty active set would zero every block — the " +
    "retired script's --force override is deliberately not offered). Every " +
    "write routes through upsertReportSection, so each cleaned section gains " +
    "an edit-history entry with the full previous payload (reversible). " +
    "Idempotent: cleaned rows drop out of the residue scan. Later product " +
    "churn can legitimately create new residue; it surfaces in this lever's " +
    "readout for the next deliberate firing.",
  change:
    "For each stored marketing section holding data blocks for inactive " +
    "products (canonical resolver, fresh per-row re-read + re-filter before " +
    "write): rewrite report_sections.data via upsertReportSection (editor=" +
    "system:inactive_products_cleanup, source=system), preserving edit " +
    "history. Unresolved-product clients skipped.",
  async status() {
    // Manual-lever contract: never 'pending' (the badge must stay zero);
    // the measured residue is surfaced in the detail string instead.
    const scan = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-inactive-scan",
      async () => {
        const { scanInactiveProductResidue } = await import(
          "../reportHistoricalHygiene"
        );
        return scanInactiveProductResidue(getDb());
      },
    );
    if (scan.actionable.length === 0) {
      return {
        state: "not-needed",
        detail:
          `Manual lever — no stored marketing section holds inactive-product data ` +
          `(${scan.scanned} scanned` +
          (scan.unresolvedSkipped > 0
            ? `; ${scan.unresolvedSkipped} dirty section(s) skipped: client resolves to no products — fix the command panel first`
            : "") +
          `).`,
      };
    }
    return {
      state: "not-needed",
      detail:
        `Manual lever — ${scan.actionable.length} of ${scan.scanned} stored marketing ` +
        `section(s) currently hold inactive-product blocks` +
        (scan.unresolvedSkipped > 0
          ? ` (+${scan.unresolvedSkipped} skipped: client resolves to no products)`
          : "") +
        `. Fire the lever to strip them (history-preserving, reversible).`,
    };
  },
  // Task #4762 — served-purpose probe: when the residue scan finds zero
  // actionable sections AND zero unresolved-skipped ones, the Task #1028
  // cleanup has reached its target state and the lever retires to History.
  // Later product churn can mint new residue — the probe then reads
  // not-served and the lever resurfaces for the next deliberate firing.
  // (unresolvedSkipped > 0 keeps it visible: those sections are dirty but
  // unactionable until the command panel is fixed, and hiding the lever
  // would hide that readout.)
  async servedPurpose() {
    const scan = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-inactive-scan",
      async () => {
        const { scanInactiveProductResidue } = await import(
          "../reportHistoricalHygiene"
        );
        return scanInactiveProductResidue(getDb());
      },
    );
    const served = scan.actionable.length === 0 && scan.unresolvedSkipped === 0;
    return {
      served,
      note: served
        ? `No stored marketing section holds inactive-product data (${scan.scanned} scanned) — Task #1028 residue fully cleaned.`
        : undefined,
    };
  },
  async apply() {
    const result = await withDbAttribution(
      "maintenance:prod-actions-report-hygiene-inactive-apply",
      async () => {
        const { applyInactiveProductCleanup } = await import(
          "../reportHistoricalHygiene"
        );
        return applyInactiveProductCleanup(getDb());
      },
    );
    if (result.cleaned === 0) {
      return {
        state: "not-needed",
        detail:
          "No stored marketing section holds inactive-product data" +
          (result.unresolvedSkipped > 0
            ? ` (${result.unresolvedSkipped} dirty section(s) skipped: client resolves to no products)`
            : "") +
          ".",
      };
    }
    return {
      state: "applied",
      detail:
        `Stripped inactive-product blocks from ${result.cleaned} marketing section(s) ` +
        `via the audited section writer (edit history preserved)` +
        (result.skippedAlreadyClean > 0
          ? `; ${result.skippedAlreadyClean} skipped as already clean on fresh re-read`
          : "") +
        (result.unresolvedSkipped > 0
          ? `; ${result.unresolvedSkipped} skipped: client resolves to no products`
          : "") +
        `.`,
      rowsAffected: result.cleaned,
    };
  },
};

// ─── Task #4289: curate the public demo report dataset ──────────────

export const curateDemoReportDatasetAction: ProdAction = {
  id: "curate_demo_report_dataset",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Curating the public demo dataset is an editorial choice — an operator decides when to re-curate; nothing accumulates behind it.",
  },
  title: "Curate the public demo report dataset (Task #4289)",
  description:
    "One-shot curation of the report that /demo-report serves (system setting `demoReportId`): rewrites its intake/sales/marketing/nextActions sections to the exemplary Task #4289 dataset (plausible monotonic funnel 365 leads → 212 consults → 71 cases, internally consistent per-platform lead-quality sums, canonical Common Issues formatting, three realistic Next-30 actions per column so the Task #4227 serve-time fallback never fires, `test.com` blog link dropped, legacy `webinars` key retired) and deletes the demo client's draft reports that hold ZERO section content (they plot as zero-months on the public \"Leads by Source (Monthly)\" trend chart). Environment-specific fields (heatmap object refs, unknown keys) are preserved by a per-key merge. Every section write goes through the audited section writer, so full previous payloads sit in report_section_history (editor `system:demo_report_curation`). Gated on a one-time `demo_report_curation_v1` stamp: a second press is a no-op, and LATER operator edits to the demo report are deliberate — the action never re-arms to revert them. Environments without a configured demo report settle to not-needed.",
  change:
    "Upserts the 4 sections of the `demoReportId` report to the curated dataset (history-preserving, env-fields merged), deletes the demo client's empty draft reports (empty `{}` section rows + their history rows first — re-verified emptiness at delete time), then stamps `demo_report_curation_v1` in system_settings.",
  async status() {
    const { scanDemoReportCuration } = await import("../demoReportCuration");
    const scan = await withDbAttribution(
      "maintenance:prod-actions-demo-report-curation-scan",
      () => scanDemoReportCuration(getDb()),
    );
    if (scan.stamped) {
      return {
        state: "not-needed",
        detail:
          "Demo report curation (v1) already applied in this environment. " +
          "Later edits to the demo report are deliberate operator changes; " +
          "this action never re-arms to revert them.",
      };
    }
    if (!scan.demoReportId) {
      return {
        state: "not-needed",
        detail:
          "System setting `demoReportId` is unset — this environment serves " +
          "no curated demo report, so there is nothing to curate.",
      };
    }
    if (!scan.reportExists) {
      return {
        state: "not-needed",
        detail: `\`demoReportId\` points at report ${scan.demoReportId}, which does not exist in this environment — nothing to curate.`,
      };
    }
    const parts: string[] = [];
    if (scan.sectionsNeedingCuration.length > 0) {
      parts.push(
        `${scan.sectionsNeedingCuration.length} demo-report section(s) differ from the curated dataset (${scan.sectionsNeedingCuration.join(", ")})`,
      );
    }
    if (scan.emptyDraftReportIds.length > 0) {
      parts.push(
        `${scan.emptyDraftReportIds.length} empty draft report(s) stretch the demo trend axis with zero-months`,
      );
    }
    if (parts.length === 0) {
      parts.push(
        "content already matches the curated dataset but the one-time stamp is missing (pressing records it so the action settles)",
      );
    }
    return {
      state: "pending",
      detail: `${parts.join("; ")}. One press curates the sections (audited, history-preserving), deletes the empty drafts, and stamps \`demo_report_curation_v1\`.`,
    };
  },
  async apply(actorId) {
    const { applyDemoReportCuration } = await import("../demoReportCuration");
    const result = await withDbAttribution(
      "maintenance:prod-actions-demo-report-curation",
      () => applyDemoReportCuration(getDb(), actorId),
    );
    if (result.outcome === "applied") {
      return {
        state: "applied",
        detail: result.detail,
        rowsAffected:
          result.sectionsCurated.length + result.emptyDraftsDeleted,
      };
    }
    return { state: "not-needed", detail: result.detail };
  },
};

// ─── Task #4252 — backfill seasonal-trend AI commentary on shared reports ─
//
// Task #4240 caches the AI seasonal-trend commentary in report_sections
// (key `seasonalTrendsAi`) at report-finalize time, and the anonymous
// /api/share/:token payload serves the stored copy. Reports finalized
// BEFORE that change have no stored copy, so their shared links still show
// the deterministic fallback text. This action generates the missing
// section for exactly those reports through the SAME finalize-path helper
// (audited upsert, idempotent on (report_id, section_key)).
//
// Convergence: the feeder is closed at ingest (every finalize since #4240
// writes the section itself), so the backlog is finite → converging.
// Reports whose client has no practice areas are EXCLUDED from pending
// (nothing to analyze — surfaced-not-pending). A candidate whose AI
// generation fails is remembered in a drain-local attempted set and counted
// as a processed `skipped` unit so the drain always terminates; a later
// press retries exactly those rows. Failures write nothing, so a stored
// good copy is never clobbered.
//
// Auth surface: the ONLY trigger is this auth-gated admin prod-action —
// the anonymous share path continues to serve only the stored copy and
// can never reach OpenAI (the explicit Task #4210 product decision).
const BACKFILL_SEASONAL_TREND_AI_ID = "backfill_seasonal_trend_ai_commentary";


function formatSeasonalTrendAiBackfillSummary(state: DrainState): string {
  const k = state.perKey ?? {};
  const generated = k.generated ?? 0;
  const skipped = k.skipped ?? 0;
  const skippedNote =
    skipped > 0
      ? `; ${skipped} skipped (AI unavailable or no trend data — nothing written; a later press retries them)`
      : "";
  return (
    `${state.processed} of ${state.totalAtStart} finalized shared report(s) processed` +
    ` — ${generated} AI commentary section(s) generated and stored${skippedNote}.`
  );
}


export const backfillSeasonalTrendAiCommentaryAction: ProdAction = {
  id: BACKFILL_SEASONAL_TREND_AI_ID,
  convergence: { kind: "converging" },
  // Task #4762 — self-drains: AI cost bounded by the drain's own chunk cap
  // + inter-call delay, idempotent on (report_id, section_key), skips
  // failures without writing (retried on a later pass), and a start while
  // the drain runs is a no-op. 6h cadence matches the other mop-ups.
  selfHeal: { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
  title: "Backfill seasonal-trend AI commentary on already-shared reports (Task #4252)",
  description:
    "Reports finalized before Task #4240 have no cached `seasonalTrendsAi` section, so their anonymous share links still show the deterministic fallback commentary instead of the AI \"Current Position\" / \"Demand Shape Ahead\" analysis new finalizes get. One press starts a worker-pool background drain over every status='final' report that has a share token, whose client has ≥1 practice area, and which is missing the section — generating the commentary through the exact finalize-path helper (one OpenAI call per report, " +
    String(SEASONAL_TREND_AI_BACKFILL_CHUNK) +
    " report(s) per chunk with a " +
    String(SEASONAL_TREND_AI_BACKFILL_DELAY_MS) +
    "ms inter-call delay) and storing it via the audited section upsert (idempotent on (report_id, section_key); history preserved). Clients without practice areas have nothing to analyze and are never counted as pending. Reports whose generation fails are skipped (nothing written — the share link keeps its current fallback) and retried by a later press. Generation only ever runs from this auth-gated action or the auth-gated finalize path — never from an anonymous share view.",
  change:
    "Background-drain over finalized+shared reports missing the seasonalTrendsAi report_sections row: compute the deterministic trend payload, one OpenAI chat completion per report (confined adapter client, 120s timeout), then upsertReportSection((report_id,'seasonalTrendsAi')) via the audited writer, " +
    String(SEASONAL_TREND_AI_BACKFILL_CHUNK) +
    " report(s)/chunk on the worker pool. AI failures write nothing and are surfaced as skipped.",
  async status() {
    if (isDrainRunning(BACKFILL_SEASONAL_TREND_AI_ID)) {
      const s = getDrainState(BACKFILL_SEASONAL_TREND_AI_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-seasonal-trend-ai-backfill-count",
      async () => {
        const { findSeasonalTrendAiBackfillCandidates } = await import(
          "../seasonalTrendAiBackfill"
        );
        return findSeasonalTrendAiBackfillCandidates(getDb());
      },
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail:
          "Every finalized shared report whose client has practice areas already carries the cached seasonalTrendsAi commentary (reports with no practice areas have nothing to analyze and are not counted).",
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} finalized shared report(s) are missing the cached AI seasonal-trend commentary; a single press generates it via background drain (${SEASONAL_TREND_AI_BACKFILL_CHUNK} report(s) per chunk, one OpenAI call each).`,
    };
  },
  async apply(actorId) {
    const {
      findSeasonalTrendAiBackfillCandidates,
      processSeasonalTrendAiBackfillCandidate,
      getSeasonalTrendAiBackfillClient,
    } = await import("../seasonalTrendAiBackfill");
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Drain-local attempted set: rows whose generation failed this drain are
    // excluded from later chunk re-queries so the loop terminates (each was
    // already counted as a processed `skipped` unit). Deliberately NOT
    // process-global — a re-press starts fresh and retries them.
    const attempted = new Set<string>();
    const out = await startBackgroundDrain(
      {
        actionId: BACKFILL_SEASONAL_TREND_AI_ID,
        actionTitle: "Backfill seasonal-trend AI commentary on already-shared reports",
        attributionLabel: "maintenance:prod-actions-seasonal-trend-ai-backfill",
        unit: "report(s)",
        formatSummary: formatSeasonalTrendAiBackfillSummary,
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-seasonal-trend-ai-backfill-count",
            () => findSeasonalTrendAiBackfillCandidates(getDb()),
          );
          return candidates.filter((c) => !attempted.has(c.reportId)).length;
        },
        runChunk: async () => {
          // getDb() resolves to the worker pool here (runDrainLoop wraps the
          // loop in runWithWorkerDb). Generated reports gain their section
          // and fall out of the candidate query; failed ones land in
          // `attempted` and are filtered here, so re-querying converges.
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-seasonal-trend-ai-backfill-count",
            () => findSeasonalTrendAiBackfillCandidates(getDb()),
          );
          const chunk = candidates
            .filter((c) => !attempted.has(c.reportId))
            .slice(0, SEASONAL_TREND_AI_BACKFILL_CHUNK);
          if (chunk.length === 0) return { processed: 0 };

          const client = await getSeasonalTrendAiBackfillClient();
          let generated = 0;
          let skipped = 0;
          for (const cand of chunk) {
            attempted.add(cand.reportId);
            // The OpenAI call runs OUTSIDE any DB hold; the helper re-enters
            // the DB only for the short audited upsert transaction.
            const outcome = await processSeasonalTrendAiBackfillCandidate(
              cand,
              client,
            );
            if (outcome === "generated") generated++;
            else skipped++;
            if (SEASONAL_TREND_AI_BACKFILL_DELAY_MS) {
              await sleep(SEASONAL_TREND_AI_BACKFILL_DELAY_MS);
            }
          }
          return {
            processed: chunk.length,
            perKey: {
              generated,
              ...(skipped > 0 ? { skipped } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
// Task #4765 — one-press retro-groom of the open-ask backlog. Production
// accumulated 276 active asks with zero ever reaching "resolved" (the
// tracker was one-way). This action runs the full-hindsight closure sweep
// across every sweepable ask (open / likely_open / likely_resolved) that
// has not yet been checkpointed (`hindsight_checked_at IS NULL`): each row
// receives a durable disposition — resolved-with-evidence /
// merged-duplicate / archived-abandoned / still-live (stamped) — so the
// dashboards' ask counts reflect reality afterwards.
export const groomOpenAskBacklogAction: ProdAction = {
  id: "groom_open_ask_backlog",
  // Converging: every disposition stamps hindsight_checked_at, permanently
  // shrinking the pending set; only genuinely new asks (which the ongoing
  // pipeline creates un-stamped) re-arm it. Errored rows stay unstamped and
  // are retried by a later press.
  convergence: { kind: "converging" },
  humanGate: {
    reason:
      "Each un-groomed ask costs one (sometimes two) fresh AI evaluations against the client's full communication history, and validated closures / duplicate merges permanently change ask statuses portfolio-wide — an operator should choose when to spend that and accept the dispositions.",
  },
  title: "Groom the open-ask backlog (hindsight closure sweep)",
  description:
    "Runs the Task #4765 full-hindsight closure sweep over every active open ask that has not yet been evaluated: semantic duplicate-merge across ask types, AI closure evaluation against the complete communication history since the ask's first mention (validated answers transition to resolved with cited evidence — which communication answered it, when), standing decay of never-re-referenced abandoned asks to an audited dismissed disposition, and a still-live checkpoint stamp otherwise. One press starts a resumable background drain on the worker pool; every per-row disposition is durable, so an interrupted drain resumes exactly where it left off on the next press. Converges to zero pending rows.",
  change:
    "Background-drain on the worker pool: for each client with un-checkpointed sweepable client_open_asks rows, run sweepClientOpenAsks(clientId) — per-row AI dedup + closure evaluation, writing status transitions (resolved / dismissed) with audited resolution notes and stamping hindsight_checked_at on every evaluated row.",
  async status() {
    const { isDrainRunning, getDrainState, formatDrainProgress } = await import(
      "../prodActionBackgroundDrain"
    );
    if (isDrainRunning("groom_open_ask_backlog")) {
      const s = getDrainState("groom_open_ask_backlog")!;
      return {
        state: "pending",
        working: true,
        detail: `Background groom in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { countHindsightPending } = await import("../openAskPipeline");
    const pending = await countHindsightPending();
    if (pending === 0) {
      return {
        state: "not-needed",
        detail:
          "Every active open ask has been groomed — each carries a hindsight-sweep disposition (resolved with evidence, merged duplicate, archived, or a still-live checkpoint stamp). New asks re-arm this action when the ongoing pipeline creates them.",
      };
    }
    return {
      state: "pending",
      detail: `${pending} active open ask(s) have never been evaluated against full communication history. One press starts a resumable background drain: AI duplicate-merge + hindsight closure per ask (~5-15s each), stamping a durable disposition on every row.`,
    };
  },
  async apply(actorId) {
    const { startBackgroundDrain } = await import("../prodActionBackgroundDrain");
    const { countHindsightPending, listClientsWithHindsightPending, sweepClientOpenAsks } =
      await import("../openAskPipeline");
    const out = await startBackgroundDrain(
      {
        actionId: "groom_open_ask_backlog",
        actionTitle: "Groom the open-ask backlog (hindsight closure sweep)",
        attributionLabel: "prod-action:groom-open-ask-backlog",
        unit: "ask(s)",
        countPending: countHindsightPending,
        async runChunk() {
          const [clientId] = await listClientsWithHindsightPending(1);
          if (!clientId) return { processed: 0 };
          // Bounded per chunk so the drain heartbeat stays honest and a
          // crash loses at most one client's in-flight evaluations.
          const counts = await sweepClientOpenAsks(clientId, { limit: 10 });
          // Errors are NOT processed (rows stay unstamped/pending). If a
          // chunk is ALL errors, report 0 so the drain ends instead of
          // hot-looping on a poisoned client forever.
          return {
            processed: counts.resolved + counts.merged + counts.archived + counts.stillLive,
            perKey: {
              resolved: counts.resolved,
              merged: counts.merged,
              archived: counts.archived,
              "still-live": counts.stillLive,
              errors: counts.errors,
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

// Task #4766 — honest handling of missing delivery data. Roughly 10 steady
// clients read deliveryStability "unknown" because their entered monthly
// reports are missing/stale. The tier gate can now fall back to MEASURED
// monthly lead totals — but only post-close snapshots count, and history
// only exists from the point the Live Data pipeline started running. This
// one-time seed pulls the recent completed months for active clients that
// have no final (post-close) snapshot yet, from real BigQuery data. Zero
// fabricated rows: a not-configured / no-data client gets an explainable
// snapshot disposition, never a silent pass, and nothing here touches the
// reports tables.
const SEED_COMPLETED_MONTHS = 6;
const SEED_PULL_CHUNK = 5; // client-period pulls per drain chunk (BQ round trips stay outside DB holds)

export const seedLiveDataCompletedMonthsAction: ProdAction = {
  id: "seed_live_data_completed_months",
  // Converging: every pull writes a post-close snapshot for its
  // client-period (ok / not-configured / no-data all count as a recorded
  // final disposition; error leaves the pair pending for a later retry).
  // The missing set only re-arms when a new month closes without the
  // scheduler close-out running — routine operation with the autopull
  // switch ON keeps it at zero.
  convergence: { kind: "converging" },
  humanGate: {
    reason:
      "One press starts a background drain that spends real BigQuery round trips (one pull per missing client-month) and writes measured snapshots that the churn tier gate will start judging delivery stability from — an operator should choose when to spend that and accept the new evidence source.",
  },
  title: "Seed measured snapshots for recent completed months",
  description:
    `Backfills the Task #4766 measured-stability evidence: for every active client, checks the last ${SEED_COMPLETED_MONTHS} completed calendar months for a final (post-close) live-data snapshot and pulls the missing ones from BigQuery via the same per-metric pipeline the hourly scheduler uses. One press starts a background drain that works oldest month first in chunks of ${SEED_PULL_CHUNK} until the backlog is exhausted, recording the final totals in History. Clients without a configured BigQuery source get an explainable not-configured snapshot (never a silent pass, never fabricated numbers).`,
  change:
    "Starts a background drain that runs runLiveDataPull({ period, clientIds }) for each (completed month, clients missing a post-close snapshot) pair, oldest month first, writing append-only live_data_snapshots rows with per-metric ok/not-configured/no-data/error dispositions.",
  async status() {
    const { liveDataRecentCompletedPeriods } = await import("../liveData/liveDataPull");
    const { listActiveClientIdsMissingFinalSnapshot } = await import(
      "../../storage/liveDataStorage"
    );
    const periods = liveDataRecentCompletedPeriods(SEED_COMPLETED_MONTHS);
    let missing = 0;
    for (const period of periods) {
      missing += (await listActiveClientIdsMissingFinalSnapshot(period)).length;
    }
    if (missing === 0) {
      return {
        state: "not-needed",
        detail: `Every active client has a final measured snapshot for each of the last ${SEED_COMPLETED_MONTHS} completed months — the tier gate's measured-stability fallback has its evidence.`,
      };
    }
    return {
      state: "pending",
      detail: `${missing} client-month(s) across the last ${SEED_COMPLETED_MONTHS} completed months have no final measured snapshot. One press starts a background drain that pulls each of them from BigQuery (oldest month first) until the backlog is exhausted; errored pulls are retried by a later drain.`,
    };
  },
  async apply(actorId) {
    const { runLiveDataPull, liveDataRecentCompletedPeriods } = await import(
      "../liveData/liveDataPull"
    );
    const { listActiveClientIdsMissingFinalSnapshot } = await import(
      "../../storage/liveDataStorage"
    );
    const { startBackgroundDrain } = await import("../prodActionBackgroundDrain");

    // Oldest completed month first so the stability series grows from the
    // back — even a partially-drained backlog yields contiguous history.
    const periods = liveDataRecentCompletedPeriods(SEED_COMPLETED_MONTHS).reverse();

    // Fairness / no-spin guard within one drain run: a client-period whose
    // pull errored keeps its snapshot non-final (still a candidate), so
    // without this the chunk re-query would re-select the same erroring
    // pair forever. `attempted` is scoped to this drain; a fresh press
    // starts clean, so errored pairs get their retry on the NEXT drain.
    const attempted = new Set<string>();
    const keyOf = (period: string, clientId: string) => `${period}|${clientId}`;

    const listMissingPairs = async (): Promise<Array<{ period: string; clientId: string }>> => {
      const pairs: Array<{ period: string; clientId: string }> = [];
      for (const period of periods) {
        const missing = await listActiveClientIdsMissingFinalSnapshot(period);
        for (const clientId of missing) {
          if (!attempted.has(keyOf(period, clientId))) pairs.push({ period, clientId });
        }
      }
      return pairs;
    };

    const out = await startBackgroundDrain(
      {
        actionId: "seed_live_data_completed_months",
        actionTitle: "Seed measured snapshots for recent completed months",
        attributionLabel: "maintenance:prod-actions-seed-live-data-completed-months",
        unit: "client-month(s)",
        countPending: async () => (await listMissingPairs()).length,
        runChunk: async () => {
          const pending = await listMissingPairs();
          if (pending.length === 0) return { processed: 0 };
          // Group the chunk's pairs by period so each period needs one pull
          // call. BigQuery round trips happen inside runLiveDataPull,
          // OUTSIDE any DB hold; pulls are sequential per client.
          const chunk = pending.slice(0, SEED_PULL_CHUNK);
          const byPeriod = new Map<string, string[]>();
          for (const p of chunk) {
            byPeriod.set(p.period, [...(byPeriod.get(p.period) ?? []), p.clientId]);
            attempted.add(keyOf(p.period, p.clientId));
          }
          let processed = 0;
          const perKey: Record<string, number> = {};
          for (const [period, clientIds] of byPeriod) {
            const summary = await runLiveDataPull({ period, clientIds });
            processed += summary.clientsProcessed;
            for (const o of summary.clientOutcomes) {
              perKey[o.overallStatus] = (perKey[o.overallStatus] ?? 0) + 1;
            }
          }
          return { processed, perKey };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return {
        state: "not-needed",
        detail: "No client-month is missing a final measured snapshot — nothing to seed.",
      };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

// Task #4803 follow-on (owner-directed CEO-button plan, 2026-08-14) —
// environment-side enabler of the Task #4765 burst-race backstop. Rollout
// COMPLETE: production held pre-existing duplicate active rows, so
// Publish's schema-only validation could not create the index built by
// migrations/20260814125621_open_ask_dedup_hindsight.sql (Publish moves
// structure, never data cleanup). The staging migration (20260814195541)
// dropped the index from dev and the model, this action was pressed in
// production on 2026-08-14 (8 duplicate twins merged with audited notes,
// index built, verified live), and Task #4811 re-anchored the index in the
// schema (model entry + idempotent migration 20260814211021) — every
// environment now starts with the backstop and this action reads
// not-needed. It stays registered as the per-environment enabler for any
// environment that somehow lacks the index (e.g. a database restored from
// a pre-rollout backup): merge duplicate active asks into their oldest
// keeper with the 125621 migration's exact semantics, then build the same
// partial unique index — one transaction, verified before commit.
const OPEN_ASK_DEDUP_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS client_open_asks_active_summary_uniq
    ON client_open_asks (client_id, md5(lower(btrim(summary))))
    WHERE status IN ('open', 'likely_open', 'likely_resolved')`;

async function readOpenAskDedupState(runner: {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>;
}): Promise<{ dupGroups: number; indexPresent: boolean }> {
  const res = await runner.execute(sql`
    SELECT
      (SELECT count(*)::int FROM (
         SELECT 1
         FROM client_open_asks
         WHERE status IN ('open', 'likely_open', 'likely_resolved')
         GROUP BY client_id, md5(lower(btrim(summary)))
         HAVING count(*) > 1
       ) g) AS dup_groups,
      (to_regclass('public.client_open_asks_active_summary_uniq') IS NOT NULL) AS index_present
  `);
  const row = res.rows[0] as { dup_groups: number | string; index_present: boolean };
  return { dupGroups: Number(row.dup_groups), indexPresent: row.index_present === true };
}

export const enableOpenAskDedupConstraintAction: ProdAction = {
  id: "enable_open_ask_dedup_constraint",
  // Converging: one successful press leaves the index in place, and the
  // index itself makes new active duplicates physically impossible — the
  // pending state can never legitimately return in that environment.
  convergence: { kind: "converging" },
  humanGate: {
    reason:
      "One-shot constraint enablement that merges live duplicate active asks (audited keeper dismissals) before building the uniqueness backstop — the operator presses it once, deliberately, right after the publish that ships it.",
  },
  title: "Enable the open-ask duplicate backstop (dedup + unique index)",
  description:
    "Environment-side enabler of the Task #4765 duplicate backstop: one press merges each duplicate active-ask group into its oldest row (mention counts summed, source ids unioned, newer twins dismissed with an audited note naming the keeper) and then builds the partial unique index client_open_asks_active_summary_uniq — atomically, in one verified transaction. Idempotent one-shot: once the backstop is live the action reads not-needed. Rollout completed 2026-08-14: pressed in production (8 twins merged, index built) and the index is re-anchored in the schema (Task #4811, migration 20260814211021), so every environment starts with the backstop and this normally reads not-needed everywhere; it remains available for a database restored from a pre-rollout backup.",
  change:
    "Single transaction under a SHARE ROW EXCLUSIVE table lock (in-flight ask writers commit first, new writes wait, reads stay open): absorb duplicate active client_open_asks rows into their oldest keeper (Task #4765 migration semantics), dismiss the absorbed twins with audited notes, CREATE UNIQUE INDEX IF NOT EXISTS client_open_asks_active_summary_uniq, and verify zero duplicate groups + index present before commit.",
  async status() {
    return withDbAttribution("prod-action:enable-open-ask-dedup-constraint", async () => {
      const db = getDb();
      const s = await readOpenAskDedupState(db);
      if (s.indexPresent) {
        return {
          state: "not-needed" as const,
          detail:
            "client_open_asks_active_summary_uniq is live — concurrent duplicate active asks are physically blocked at the DB. Nothing to enable.",
        };
      }
      return {
        state: "pending" as const,
        detail: `The open-ask duplicate backstop is NOT enabled in this environment: ${s.dupGroups} duplicate active group(s) to merge, then the partial unique index is built. One press does both in a single verified transaction (keep-oldest keeper semantics, audited dismissal notes).`,
      };
    });
  },
  async apply() {
    return withDbAttribution("prod-action:enable-open-ask-dedup-constraint", async () => {
      const db = getDb();
      try {
        const pre = await readOpenAskDedupState(db);
        if (pre.indexPresent) {
          return {
            state: "not-needed" as const,
            detail:
              "client_open_asks_active_summary_uniq already exists — the backstop is live; nothing to merge or build.",
          };
        }
        let dismissed = 0;
        let alreadyLive = false;
        await db.transaction(async (tx) => {
          // Freeze the table against ALL row writers for the duration of
          // the press: SHARE ROW EXCLUSIVE conflicts with every
          // INSERT/UPDATE/DELETE (and with itself, so concurrent presses
          // serialize too) while leaving reads open. In-flight extraction
          // merges must commit before the dedup snapshot below is taken —
          // without this, a live merge into a duplicate twin landing
          // between the absorb and dismiss steps would be silently
          // discarded with the dismissed twin. Milliseconds of write
          // blockage at this table's size.
          await tx.execute(sql`LOCK TABLE client_open_asks IN SHARE ROW EXCLUSIVE MODE`);
          // Re-check under the lock: a concurrent press that committed
          // while we waited leaves nothing to do.
          const underLock = await readOpenAskDedupState(tx);
          if (underLock.indexPresent) {
            alreadyLive = true;
            return;
          }
          // Step 1 — absorb duplicate tallies into the oldest keeper
          // (mirrors migrations/20260814125621 step 2a verbatim).
          await tx.execute(sql`
            WITH ranked AS (
              SELECT id,
                     client_id,
                     md5(lower(btrim(summary))) AS norm,
                     mention_count,
                     source_record_ids,
                     ROW_NUMBER() OVER (
                       PARTITION BY client_id, md5(lower(btrim(summary)))
                       ORDER BY created_at ASC, id ASC
                     ) AS rn,
                     FIRST_VALUE(id) OVER (
                       PARTITION BY client_id, md5(lower(btrim(summary)))
                       ORDER BY created_at ASC, id ASC
                     ) AS keeper_id
              FROM client_open_asks
              WHERE status IN ('open', 'likely_open', 'likely_resolved')
            ),
            dupes AS (
              SELECT keeper_id,
                     SUM(COALESCE(mention_count, 1)) AS extra_mentions,
                     ARRAY(
                       SELECT DISTINCT unnested
                       FROM ranked r2, unnest(COALESCE(r2.source_record_ids, '{}')) AS unnested
                       WHERE r2.keeper_id = ranked.keeper_id AND r2.rn > 1
                     ) AS extra_sources
              FROM ranked
              WHERE rn > 1
              GROUP BY keeper_id
            )
            UPDATE client_open_asks k
            SET mention_count = COALESCE(k.mention_count, 1) + d.extra_mentions,
                source_record_ids = (
                  SELECT ARRAY(
                    SELECT DISTINCT s FROM unnest(COALESCE(k.source_record_ids, '{}') || d.extra_sources) AS s
                  )
                ),
                updated_at = NOW()
            FROM dupes d
            WHERE k.id = d.keeper_id
          `);
          // Step 2 — dismiss the absorbed duplicates with an audited
          // disposition (mirrors step 2b; the note names this action).
          const dis = await tx.execute(sql`
            WITH ranked AS (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY client_id, md5(lower(btrim(summary)))
                       ORDER BY created_at ASC, id ASC
                     ) AS rn,
                     FIRST_VALUE(id) OVER (
                       PARTITION BY client_id, md5(lower(btrim(summary)))
                       ORDER BY created_at ASC, id ASC
                     ) AS keeper_id
              FROM client_open_asks
              WHERE status IN ('open', 'likely_open', 'likely_resolved')
            )
            UPDATE client_open_asks a
            SET status = 'dismissed',
                resolution_note = 'Merged duplicate of ' || r.keeper_id || ' (enable_open_ask_dedup_constraint prod action)',
                resolved_at = NOW(),
                updated_at = NOW()
            FROM ranked r
            WHERE a.id = r.id AND r.rn > 1
          `);
          dismissed = Number((dis as { rowCount?: number }).rowCount ?? 0);
          // Step 3 — the constraint itself (verbatim DDL from the 125621
          // migration; IF NOT EXISTS keeps replay idempotent).
          await tx.execute(sql.raw(OPEN_ASK_DEDUP_INDEX_DDL));
          // Verify inside the transaction: zero duplicate groups AND the
          // index present, else roll the whole press back.
          const post = await readOpenAskDedupState(tx);
          if (!post.indexPresent || post.dupGroups > 0) {
            throw new Error(
              `verification failed — dupGroups=${post.dupGroups}, indexPresent=${post.indexPresent}`,
            );
          }
        });
        if (alreadyLive) {
          return {
            state: "not-needed" as const,
            detail:
              "client_open_asks_active_summary_uniq already exists — the backstop is live; nothing to merge or build.",
          };
        }
        return {
          state: "applied" as const,
          detail: `Merged ${dismissed} duplicate active ask(s) into their oldest keepers (mention counts summed, source ids unioned, audited dismissal notes) and created client_open_asks_active_summary_uniq — the burst-race backstop is live in this environment.`,
          rowsAffected: dismissed,
        };
      } catch (err) {
        return {
          state: "error" as const,
          detail: `Constraint enablement failed — the transaction rolled back cleanly, no partial state was left behind: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
  },
};

const PURGE_AI_VERDICTS_ID = "purge_ai_authored_slide_verdicts";
const PURGE_AI_VERDICTS_CHUNK = 10;
const PURGE_AI_VERDICTS_DELAY_MS = 100;

function describePurgeCandidate(c: SlideVerdictPurgeCandidate): string {
  return `${c.reportMonth ?? c.reportId} (${c.clears.map((x) => x.key).join(", ")})`;
}

/**
 * Task #4902 — one-press purge of AI-authored slide-verdict copy from
 * existing reports. Companion to the same task's removal of the finalize
 * auto-drafting kick and retirement of the lifetimeValue verdict slot;
 * attribution + write mechanics live in server/services/slideVerdictPurge.ts.
 */
export const purgeAiSlideVerdictsAction: ProdAction = {
  id: PURGE_AI_VERDICTS_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deletes AI-drafted verdict sentences from finalized client reports (owner mandate, Task #4902) — an operator confirms before published report copy is removed. Operator-written verdicts are kept, and every clear is journaled in section edit history.",
  },
  title: "Purge AI-authored slide verdicts from existing reports (Task #4902)",
  description:
    "Owner decision: AI-invented advice must not appear on client-facing reports (e.g. the Jones Law Firm July 2026 Lifetime Value line \"Average case nets $12,500 now — increase client value through defined upsell or retention offers.\"). Task #4902 already stopped finalize-time auto-drafting; this action cleans up what it previously wrote. For every stored slideVerdicts section row, each key's current value is attributed via the report_section_history journal: values introduced by the retired finalize AI identity (system:slide-verdicts-ai) are cleared; operator-written values — including operator-applied \"Draft with AI\" sentences, which were saved under the operator's own id — are kept; retired lifetimeValue keys are cleared regardless of author (the slot no longer exists). Keys whose author cannot be established from history are conservatively KEPT and reported. Writes are per-key value-CAS under a row lock, so an operator edit landing mid-run always wins, and every clear appends a history row (previous copy stays recoverable verbatim). Convergent: purged rows fall out of the candidate set, so the action settles to 'not needed' after one pass.",
  change:
    "Background-drain UPDATE of report_sections.data.verdicts (slideVerdicts rows only, other keys preserved) clearing AI-introduced and retired-slot entries, " +
    String(PURGE_AI_VERDICTS_CHUNK) +
    " report(s)/chunk through storage.purgeSlideVerdictKeys (FOR UPDATE + per-key value-CAS + report_section_history journaling).",
  async status() {
    if (isDrainRunning(PURGE_AI_VERDICTS_ID)) {
      const s = getDrainState(PURGE_AI_VERDICTS_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const scan = await withDbAttribution(
      "maintenance:prod-actions-purge-ai-slide-verdicts-count",
      () => scanSlideVerdictPurgeCandidates(getDb()),
    );
    if (scan.candidates.length === 0) {
      const unattributedNote =
        scan.unattributedKeys > 0
          ? ` ${scan.unattributedKeys} key(s) were conservatively kept because history carries no introducing write — review them in the editor if any AI line is still visible.`
          : "";
      return {
        state: "not-needed",
        detail: `No stored slide verdict is attributable to the retired finalize AI (${scan.scanned} verdict row(s) checked; operator-written copy untouched).${unattributedNote}`,
      };
    }
    const preview = scan.candidates.slice(0, 5).map(describePurgeCandidate).join("; ");
    const totalKeys = scan.candidates.reduce((n, c) => n + c.clears.length, 0);
    return {
      state: "pending",
      detail: `${scan.candidates.length} report(s) carry ${totalKeys} AI-authored or retired-slot verdict key(s) — e.g. ${preview}. A single press clears them via background drain (${PURGE_AI_VERDICTS_CHUNK} report(s) per chunk); operator-written verdicts are kept.`,
    };
  },
  async apply(actorId) {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Reports where a per-key CAS lost to a mid-run operator edit AND nothing
    // else was cleared. Excluded from every later chunk of THIS run (the
    // operator's fresh edit is never retried against); the next press
    // re-attributes them from fresh history.
    const conflicted = new Set<string>();
    const out = await startBackgroundDrain(
      {
        actionId: PURGE_AI_VERDICTS_ID,
        actionTitle: "Purge AI-authored slide verdicts from existing reports",
        attributionLabel: "maintenance:prod-actions-purge-ai-slide-verdicts",
        unit: "report(s)",
        countPending: async () => {
          const scan = await withDbAttribution(
            "maintenance:prod-actions-purge-ai-slide-verdicts-count",
            () => scanSlideVerdictPurgeCandidates(getDb()),
          );
          return scan.candidates.length;
        },
        runChunk: async () => {
          // Re-scan each chunk: purged rows stop matching, so the drain
          // converges without any processed-marker bookkeeping.
          const scan = await withDbAttribution(
            "maintenance:prod-actions-purge-ai-slide-verdicts-count",
            () => scanSlideVerdictPurgeCandidates(getDb()),
          );
          const chunk = scan.candidates
            .filter((c) => !conflicted.has(c.reportId))
            .slice(0, PURGE_AI_VERDICTS_CHUNK);
          if (chunk.length === 0) return { processed: 0 };

          let processed = 0;
          let clearedKeys = 0;
          let conflictKeys = 0;
          for (const cand of chunk) {
            const res = await withDbAttribution(
              "maintenance:prod-actions-purge-ai-slide-verdicts-apply",
              () => purgeSlideVerdictCandidate(cand),
            );
            // Audit trail: name every touched report and exactly what moved.
            console.log(
              `[purge-ai-slide-verdicts] report=${cand.reportId} month=${cand.reportMonth ?? "?"} ` +
                `cleared=[${res.clearedKeys.join(",")}] conflicts=[${res.conflictKeys.join(",")}] ` +
                `keptOperator=[${cand.keptOperatorKeys.join(",")}] keptUnattributed=[${cand.keptUnattributedKeys.join(",")}]`,
            );
            clearedKeys += res.clearedKeys.length;
            conflictKeys += res.conflictKeys.length;
            if (res.changed) {
              processed++;
            } else {
              // Nothing cleared (every targeted key conflicted or vanished):
              // leave the operator's edit alone for the rest of this run.
              conflicted.add(cand.reportId);
            }
            if (PURGE_AI_VERDICTS_DELAY_MS) {
              await sleep(PURGE_AI_VERDICTS_DELAY_MS);
            }
          }
          return {
            processed,
            perKey: {
              clearedKeys,
              ...(conflictKeys > 0 ? { conflictKeys } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

export const reportContentDomain: ProdActionDomain = {
  name: "reportContent",
  actions: [
    cleanupLegacyKeywordSpellingsAction,
    backfillHeatmapSnapshotClientLinksAction,
    sanitizeSavedLinkPreviewAssetsAction,
    backfillCommsAttachmentThumbnailsAction,
    reformatCommonIssuesAllReportsAction,
    repairDegenerateCommonIssuesFinalReportsAction,
    clearPlaceholderCommonIssuesAction,
    reparseJune2026ReportLeadsAction,
    rejudgeStaleClientJudgmentsAction,
    deactivateFabricatedZeroMetricFactsAction,
    reviewWebinarBreakdownMismatchesAction,
    healImportedFabricatedZeroMetricsAction,
    backfillEmptyReportSectionsAction,
    backfillReportSectionHistoryAction,
    cleanupInactiveProductReportBlocksAction,
    curateDemoReportDatasetAction,
    backfillSeasonalTrendAiCommentaryAction,
    purgeAiSlideVerdictsAction,
    groomOpenAskBacklogAction,
    enableOpenAskDedupConstraintAction,
    seedLiveDataCompletedMonthsAction,
  ],
};
