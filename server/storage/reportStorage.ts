// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type CeoPulse, type InsertCeoPulse, ceoPulses,
  type UpdateCeoPulse,
  type Report, type InsertReport, reports,
  type UpdateReport, updateReportSchema,
  type ReportSection, type InsertReportSection, reportSections,
  type ReportSectionHistory, reportSectionHistory,
  type ReportSectionEditSource, REPORT_SECTION_EDIT_SOURCES,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { desc, eq, and, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface ReportSectionWriteAttribution {
  editor: string;
  source: ReportSectionEditSource;
  webhookImportLogId?: string | null;
}

function ensureValidAttribution(
  attribution: Partial<ReportSectionWriteAttribution> | undefined,
  context: string,
): ReportSectionWriteAttribution {
  const editor = (attribution?.editor || "").trim();
  const source = attribution?.source as ReportSectionEditSource | undefined;
  const isValidSource = source && (REPORT_SECTION_EDIT_SOURCES as readonly string[]).includes(source);
  if (!editor || !isValidSource) {
    const message = `[report-section-audit] Refusing to write report section without attribution (${context}). editor=${editor || "<missing>"} source=${source || "<missing>"}`;
    if (process.env.NODE_ENV === "production") {
      console.error(message);
    } else {
      throw new Error(message);
    }
  }
  return {
    editor: editor || "unknown",
    source: (isValidSource ? source : "unknown") as ReportSectionEditSource,
    webhookImportLogId: attribution?.webhookImportLogId ?? null,
  };
}

function isJsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export async function getCeoPulses(): Promise<CeoPulse[]> {
  return getDb().select().from(ceoPulses).orderBy(desc(ceoPulses.monthKey));
}

export async function getCeoPulse(id: string): Promise<CeoPulse | undefined> {
  const [pulse] = await getDb().select().from(ceoPulses).where(eq(ceoPulses.id, id));
  return pulse;
}

export async function getCeoPulseByMonth(monthKey: string): Promise<CeoPulse | undefined> {
  const [pulse] = await getDb().select().from(ceoPulses).where(eq(ceoPulses.monthKey, monthKey));
  return pulse;
}

export async function getCeoPulseByShareToken(token: string): Promise<CeoPulse | undefined> {
  const [pulse] = await getDb().select().from(ceoPulses).where(eq(ceoPulses.shareToken, token));
  return pulse;
}

export async function createCeoPulse(data: InsertCeoPulse): Promise<CeoPulse> {
  const [pulse] = await getDb().insert(ceoPulses).values(data).returning();
  return pulse;
}

// Task #4380 (F8): dedicated narrow writer type. The share-mint path in
// reports.ts legitimately sets shareToken (a server-managed column omitted
// from updateCeoPulseSchema), so a runtime parse would silently strip it —
// the compile-time contract below closes the broad Partial<Insert*> hole
// while keeping that internal write. Route-facing PATCHes still parse
// through updateCeoPulseSchema at the boundary.
export type CeoPulseStoragePatch = UpdateCeoPulse & Partial<Pick<CeoPulse, "shareToken">>;

export async function updateCeoPulse(id: string, data: CeoPulseStoragePatch): Promise<CeoPulse | undefined> {
  const [pulse] = await getDb().update(ceoPulses).set({ ...data, updatedAt: new Date() }).where(eq(ceoPulses.id, id)).returning();
  return pulse;
}

// ── ceo_pulses.supporting_images writers (Task #4293) ──────────────────────
// The ONLY writers of this column (it is omitted from insert/update schemas,
// so generic POST/PATCH can never touch it). Each is a single-statement
// UPDATE, so slot allocation and the count cap are race-safe without a
// SELECT-then-UPDATE window: concurrent uploads serialize on the row lock
// and re-evaluate both the WHERE cap check and the max-slot subquery against
// the committed row (READ COMMITTED re-check). No transaction ever spans the
// object-storage write — the route appends metadata, then writes bytes, and
// compensates with removeCeoPulseSupportingImage on storage failure.

/**
 * Atomically append a new image entry with slot = MAX(existing slots)+1,
 * enforcing the per-brief count cap in the same statement. Returns the newly
 * allocated slot and the full updated array, or null when the cap is already
 * reached (or the row vanished — callers load the pulse first, so a null is
 * reported as the cap). Slots are never reused while entries remain, and the
 * caption starts null (captions are edited via the caption/reorder writer).
 */
export async function appendCeoPulseSupportingImage(
  id: string,
  ext: string,
  maxCount: number,
): Promise<{ slot: number; images: unknown } | null> {
  const result = await withDbAttribution("reports:appendCeoPulseSupportingImage", () => getDb().execute(sql`
    UPDATE ceo_pulses
    SET supporting_images = COALESCE(supporting_images, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'slot', COALESCE((
            SELECT MAX((e->>'slot')::int)
            FROM jsonb_array_elements(COALESCE(supporting_images, '[]'::jsonb)) AS e
          ), 0) + 1,
          'ext', ${ext}::text,
          'caption', NULL
        )
      ),
      updated_at = NOW()
    WHERE id = ${id}
      AND jsonb_array_length(COALESCE(supporting_images, '[]'::jsonb)) < ${maxCount}
    RETURNING supporting_images
  `));
  const row = result.rows[0] as { supporting_images?: unknown } | undefined;
  if (!row) return null;
  const images = row.supporting_images;
  // The appended entry is always the last element of the returned array.
  const last = Array.isArray(images) ? (images[images.length - 1] as { slot?: unknown }) : undefined;
  const slot = typeof last?.slot === "number" ? last.slot : null;
  if (slot === null) return null;
  return { slot, images };
}

/**
 * Atomically remove one entry by slot, preserving the order of the rest.
 * Returns the updated array, or null when the pulse row or the slot entry
 * did not exist (a retried delete hits this — callers treat it as already
 * removed and still attempt the idempotent object delete). Slot comparison
 * is TEXTUAL (`->>'slot'`), so a hand-corrupted non-numeric entry can never
 * crash the statement — such entries are unreachable and dropped by the
 * read accessor instead.
 */
export async function removeCeoPulseSupportingImage(
  id: string,
  slot: number,
): Promise<{ images: unknown } | null> {
  const slotText = String(slot);
  const result = await withDbAttribution("reports:removeCeoPulseSupportingImage", () => getDb().execute(sql`
    UPDATE ceo_pulses
    SET supporting_images = COALESCE((
        SELECT jsonb_agg(e.value ORDER BY e.ord)
        FROM jsonb_array_elements(COALESCE(supporting_images, '[]'::jsonb)) WITH ORDINALITY AS e(value, ord)
        WHERE e.value->>'slot' IS DISTINCT FROM ${slotText}
      ), '[]'::jsonb),
      updated_at = NOW()
    WHERE id = ${id}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(supporting_images, '[]'::jsonb)) AS x
        WHERE x->>'slot' = ${slotText}
      )
    RETURNING supporting_images
  `));
  const row = result.rows[0] as { supporting_images?: unknown } | undefined;
  if (!row) return null;
  return { images: row.supporting_images };
}

/**
 * Replace the full image list (caption edits + reorder in one write). The
 * route validates the new list is an exact slot-permutation of the stored
 * one and re-derives `ext` from stored metadata before calling this, so the
 * client can never add/remove entries or change extensions through it.
 */
export async function replaceCeoPulseSupportingImages(
  id: string,
  images: unknown[],
): Promise<CeoPulse | undefined> {
  const [pulse] = await withDbAttribution("reports:replaceCeoPulseSupportingImages", () =>
    getDb()
      .update(ceoPulses)
      .set({ supportingImages: images, updatedAt: new Date() })
      .where(eq(ceoPulses.id, id))
      .returning(),
  );
  return pulse;
}

export async function getReports(): Promise<Report[]> {
  return getDb().select().from(reports).orderBy(desc(reports.createdAt));
}

export async function getReportsPaginated(limit: number, offset: number): Promise<{ data: Report[]; total: number }> {
  const [countResult] = await getDb().select({ count: sql<number>`count(*)::int` }).from(reports);
  const data = await getDb().select().from(reports).orderBy(desc(reports.createdAt)).limit(limit).offset(offset);
  return { data, total: countResult?.count || 0 };
}

export async function getReport(id: string): Promise<Report | undefined> {
  const [report] = await getDb().select().from(reports).where(eq(reports.id, id));
  return report;
}

export async function getReportByShareToken(token: string): Promise<Report | undefined> {
  const [report] = await getDb().select().from(reports).where(eq(reports.shareToken, token));
  return report;
}

export async function getReportsByClient(clientId: string): Promise<Report[]> {
  return getDb().select().from(reports).where(eq(reports.clientId, clientId)).orderBy(desc(reports.reportMonth));
}

export async function getReportsByClientIds(clientIds: string[]): Promise<Report[]> {
  if (clientIds.length === 0) return [];
  return getDb().select().from(reports).where(inArray(reports.clientId, clientIds)).orderBy(desc(reports.reportMonth));
}

export async function createReport(data: InsertReport): Promise<Report> {
  const shareToken = randomUUID();
  const [report] = await getDb().insert(reports).values({ ...data, shareToken }).returning();
  return report;
}

export async function updateReport(id: string, data: UpdateReport): Promise<Report | undefined> {
  // Task #4380 (F8): runtime parse — ownership (clientId/createdBy) and
  // server-managed columns (shareToken, ceoPulseId, import provenance) are
  // omitted from updateReportSchema; unknown keys strip.
  const parsed = updateReportSchema.parse(data);
  const [report] = await getDb().update(reports).set({ ...parsed, updatedAt: new Date() }).where(eq(reports.id, id)).returning();
  return report;
}

// Task #4537 — the ONLY writer of reports.presented_at / presented_by (both
// are omitted from insertReportSchema/updateReportSchema, so the generic
// create/update paths can never touch them). The PATCH route derives the
// stamp server-side from the authenticated actor: { presentedAt: now,
// presentedBy: userId } to mark, both null to clear. Client-supplied values
// are never accepted.
export async function setReportPresented(
  id: string,
  stamp: { presentedAt: Date | null; presentedBy: string | null },
): Promise<Report | undefined> {
  const [report] = await withDbAttribution("reports:setReportPresented", () =>
    getDb()
      .update(reports)
      .set({
        presentedAt: stamp.presentedAt,
        presentedBy: stamp.presentedBy,
        updatedAt: new Date(),
      })
      .where(eq(reports.id, id))
      .returning(),
  );
  return report;
}

export async function deleteReport(id: string): Promise<void> {
  await getDb().delete(reportSections).where(eq(reportSections.reportId, id));
  await getDb().delete(reports).where(eq(reports.id, id));
}

export async function getReportSections(reportId: string): Promise<ReportSection[]> {
  return getDb().select().from(reportSections).where(eq(reportSections.reportId, reportId));
}

export async function getReportSection(reportId: string, sectionKey: string): Promise<ReportSection | undefined> {
  const [section] = await getDb().select().from(reportSections)
    .where(and(eq(reportSections.reportId, reportId), eq(reportSections.sectionKey, sectionKey)));
  return section;
}

export async function upsertReportSection(
  data: InsertReportSection,
  attribution?: Partial<ReportSectionWriteAttribution>,
): Promise<ReportSection> {
  const attr = ensureValidAttribution(attribution, `report=${data.reportId} section=${data.sectionKey}`);
  const db = getDb();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(reportSections)
      .where(and(eq(reportSections.reportId, data.reportId), eq(reportSections.sectionKey, data.sectionKey)));

    const dataChanged = !existing || !isJsonEqual(existing.data, data.data);

    const [section] = await tx.insert(reportSections)
      .values({
        ...data,
        lastEditedBy: attr.editor,
        lastEditSource: attr.source,
        lastEditAt: now,
      })
      .onConflictDoUpdate({
        target: [reportSections.reportId, reportSections.sectionKey],
        set: {
          data: data.data,
          updatedAt: now,
          lastEditedBy: attr.editor,
          lastEditSource: attr.source,
          lastEditAt: now,
        },
      })
      .returning();

    await tx.insert(reportSectionHistory).values({
      reportSectionId: section.id,
      reportId: data.reportId,
      sectionKey: data.sectionKey,
      previousData: existing ? existing.data : null,
      newData: data.data,
      dataChanged,
      editedBy: attr.editor,
      editSource: attr.source,
      webhookImportLogId: attr.webhookImportLogId ?? null,
    });

    return section;
  });
}

/** One key-clear request for `purgeSlideVerdictKeys`. */
export interface SlideVerdictKeyClear {
  key: string;
  /**
   * Value-CAS guard: the key is cleared only while its stored value still
   * strictly equals this string (the value the caller attributed as
   * AI-authored). `null` = unconditional clear — reserved for RETIRED keys
   * (e.g. `lifetimeValue`) that no live write path can reintroduce, where
   * any value must go regardless of author.
   */
  expectedValue: string | null;
}

export interface SlideVerdictPurgeWriteResult {
  clearedKeys: string[];
  /** Keys whose stored value changed since attribution (operator edit wins). */
  conflictKeys: string[];
  changed: boolean;
}

/**
 * Task #4902 — audited per-key CLEAR on the slideVerdicts section row
 * (data shape `{ verdicts: {slideKey: sentence}, ... }`). Replaces the
 * deleted Task #4273 `mergeSlideVerdictsSection` as the single
 * verdict-specific storage writer.
 *
 * Concurrency contract (Governor P1): the whole decision-to-write executes
 * under a `FOR UPDATE` row lock, and each clear is a per-key value-CAS —
 * a key is dropped only while its stored value still equals the one the
 * caller attributed as AI-authored (an operator edit landing between the
 * caller's scan and this write changes the value, so the CAS keeps it and
 * reports a conflict instead). Every effective write appends a
 * report_section_history row, so cleared copy stays recoverable verbatim
 * from `previousData`.
 */
export async function purgeSlideVerdictKeys(
  reportId: string,
  sectionKey: string,
  clears: SlideVerdictKeyClear[],
  attribution?: Partial<ReportSectionWriteAttribution>,
): Promise<SlideVerdictPurgeWriteResult> {
  const attr = ensureValidAttribution(attribution, `report=${reportId} section=${sectionKey}`);
  const now = new Date();

  return withDbAttribution("reportStorage.purgeSlideVerdictKeys", async () => {
    const db = getDb();
    return db.transaction(async (tx): Promise<SlideVerdictPurgeWriteResult> => {
      const [existing] = await tx.select().from(reportSections)
        .where(and(eq(reportSections.reportId, reportId), eq(reportSections.sectionKey, sectionKey)))
        .for("update");
      if (!existing) {
        return { clearedKeys: [], conflictKeys: [], changed: false };
      }

      const data =
        existing.data && typeof existing.data === "object" && !Array.isArray(existing.data)
          ? (existing.data as Record<string, unknown>)
          : {};
      const storedVerdicts =
        data.verdicts && typeof data.verdicts === "object" && !Array.isArray(data.verdicts)
          ? (data.verdicts as Record<string, unknown>)
          : {};
      const verdicts: Record<string, unknown> = { ...storedVerdicts };

      const clearedKeys: string[] = [];
      const conflictKeys: string[] = [];
      for (const { key, expectedValue } of clears) {
        if (!(key in verdicts)) continue; // already gone — nothing to clear
        if (expectedValue !== null && verdicts[key] !== expectedValue) {
          conflictKeys.push(key);
          continue;
        }
        delete verdicts[key];
        clearedKeys.push(key);
      }
      if (clearedKeys.length === 0) {
        return { clearedKeys, conflictKeys, changed: false };
      }

      const nextData: Record<string, unknown> = { ...data, verdicts };

      const [section] = await tx.update(reportSections)
        .set({
          data: nextData,
          updatedAt: now,
          lastEditedBy: attr.editor,
          lastEditSource: attr.source,
          lastEditAt: now,
        })
        .where(eq(reportSections.id, existing.id))
        .returning();

      await tx.insert(reportSectionHistory).values({
        reportSectionId: section.id,
        reportId,
        sectionKey,
        previousData: existing.data,
        newData: nextData,
        dataChanged: true,
        editedBy: attr.editor,
        editSource: attr.source,
        webhookImportLogId: attr.webhookImportLogId ?? null,
      });

      return { clearedKeys, conflictKeys, changed: true };
    });
  });
}

export async function getReportSectionHistory(
  reportId: string,
  sectionKey?: string,
): Promise<ReportSectionHistory[]> {
  const where = sectionKey
    ? and(eq(reportSectionHistory.reportId, reportId), eq(reportSectionHistory.sectionKey, sectionKey))
    : eq(reportSectionHistory.reportId, reportId);
  return getDb().select().from(reportSectionHistory)
    .where(where)
    .orderBy(desc(reportSectionHistory.createdAt));
}
