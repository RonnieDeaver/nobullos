// @cross-instance-safe: producer enqueues work_queue jobs with per-day dedupe keys;
//   SKIP LOCKED ensures only one instance claims each job. The setInterval just
//   enqueues — no direct external writes per instance.

/**
 * Sheets live-data block refresh — queue handler + daily auto-refresh producer.
 *
 * Queue: `sheets_data_block_refresh`
 * Kill switch: `sheets_auto_refresh_enabled` (default OFF) — gates the daily
 * producer only; manual refreshes always go through regardless.
 *
 * DB-hold rules: connector query results are staged outside any hold, then
 * a single short hold writes the updated snapshot and block metadata.
 *
 * Handler:
 *   1. Load block metadata from sheet_data_blocks.
 *   2. Load the workbook snapshot (outside any hold).
 *   3. Run the connector query (outside any hold — may hit DB but does not
 *      hold a connection across external I/O).
 *   4. Apply the region rewrite to the snapshot clone.
 *   5. In a single short hold: persist updated snapshot + update block
 *      rowCount / lastRefreshedAt.
 *
 * Producer:
 *   A `setInterval` enqueues one job per auto-refresh block on a 24h cadence.
 *   Each job uses a dedupe key `sheets_block_refresh:<blockId>:<dateBucket>`
 *   so repeated ticks within the same day collapse to a single job.
 */

import { workerDb } from "../db";
import { eq, sql } from "drizzle-orm";
import { sheetWorkbooks, sheetDataBlocks } from "@shared/schema";
import { enqueueJob } from "./workScheduler";
import { isKillSwitchEnabled } from "./killSwitches";
import { workerLog } from "./workerLogger";
import { getConnector } from "./sheetsConnectors";
import * as sheetsOps from "../storage/sheetsStorage";
import type { WorkQueueJob } from "@shared/schema";

export const SHEETS_REFRESH_QUEUE = "sheets_data_block_refresh";

const PRODUCER_INTERVAL_MS = 6 * 60 * 60 * 1000; // check every 6h; jobs dedupe within the day
const DATE_BUCKET_MS = 24 * 60 * 60 * 1000;

let producerTimer: ReturnType<typeof setInterval> | null = null;

// ─── snapshot region rewrite ─────────────────────────────────────────────────

type CellValue = string | number | null;

/**
 * Applies the connector result rows into the workbook snapshot's cell grid.
 * Clears the old region first (predictable shrink/grow), then writes the
 * header row + data rows starting at (startRow, startCol).
 *
 * Returns { updatedSnapshot, newRowCount, newColCount }.
 */
export function applyBlockToSnapshot(
  snapshot: unknown,
  opts: {
    sheetId: string;
    startRow: number;
    startCol: number;
    oldRowCount: number;
    connectorLabel: string;
    lastRefreshedAt: Date;
    headers: string[];
    rows: CellValue[][];
  },
): { updatedSnapshot: unknown; newRowCount: number; newColCount: number } {
  // Deep clone — we never mutate the caller's copy.
  const snap: any =
    snapshot && typeof snapshot === "object"
      ? JSON.parse(JSON.stringify(snapshot))
      : {};

  if (!snap.sheets) snap.sheets = {};
  if (!snap.sheets[opts.sheetId]) {
    // Create a minimal sheet if missing.
    snap.sheets[opts.sheetId] = {
      id: opts.sheetId,
      name: opts.sheetId,
      rowCount: 100,
      columnCount: 26,
      cellData: {},
    };
    if (!snap.sheetOrder) snap.sheetOrder = [];
    if (!snap.sheetOrder.includes(opts.sheetId)) {
      snap.sheetOrder.push(opts.sheetId);
    }
  }

  const sheet = snap.sheets[opts.sheetId];
  if (!sheet.cellData) sheet.cellData = {};

  const { startRow, startCol, oldRowCount } = opts;

  // ── Clear old region ──────────────────────────────────────────────────────
  // We clear more columns than needed (64 wide) to handle column-count changes.
  const clearCols = 64;
  for (let r = startRow; r < startRow + Math.max(oldRowCount, 2); r++) {
    const rowObj = sheet.cellData[String(r)];
    if (!rowObj) continue;
    for (let c = startCol; c < startCol + clearCols; c++) {
      delete rowObj[String(c)];
    }
    if (Object.keys(rowObj).length === 0) {
      delete sheet.cellData[String(r)];
    }
  }

  // ── Build all rows: meta-header + column headers + data ──────────────────
  const sourceNote = `Source: ${opts.connectorLabel} | Refreshed: ${opts.lastRefreshedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const allRows: CellValue[][] = [
    [sourceNote], // row 0 relative: meta note
    opts.headers, // row 1 relative: column headers
    ...opts.rows, // row 2+ relative: data
  ];

  let maxCols = 1;
  for (let r = 0; r < allRows.length; r++) {
    const rowData = allRows[r];
    const absRow = startRow + r;
    const rowKey = String(absRow);
    if (!sheet.cellData[rowKey]) sheet.cellData[rowKey] = {};
    for (let c = 0; c < rowData.length; c++) {
      const val = rowData[c];
      const colKey = String(startCol + c);
      if (val === null || val === undefined) {
        delete sheet.cellData[rowKey][colKey];
      } else {
        sheet.cellData[rowKey][colKey] = {
          v: val,
          t: typeof val === "number" ? 2 : 1, // Univer: 2=number, 1=string
        };
      }
    }
    maxCols = Math.max(maxCols, rowData.length);
  }

  // Ensure sheet has enough rows for the block.
  const neededRows = startRow + allRows.length + 5;
  if ((sheet.rowCount ?? 0) < neededRows) {
    sheet.rowCount = neededRows;
  }

  return {
    updatedSnapshot: snap,
    newRowCount: allRows.length,
    newColCount: maxCols,
  };
}

// ─── handler ─────────────────────────────────────────────────────────────────

interface RefreshPayload {
  blockId: string;
  userId?: string;
  userRole?: string;
}

export async function handleSheetsDataBlockRefresh(
  job: WorkQueueJob,
): Promise<void> {
  const payload = (job.payload ?? {}) as RefreshPayload;
  const { blockId } = payload;

  if (!blockId) {
    workerLog({ worker: "sheets_refresh", event: "skip_no_block_id" });
    return;
  }

  // ── Stage 1: load block metadata ─────────────────────────────────────────
  const block = await sheetsOps.getSheetDataBlock(blockId);
  if (!block) {
    workerLog({ worker: "sheets_refresh", event: "block_not_found", blockId });
    return;
  }

  // ── Stage 2: find the connector ──────────────────────────────────────────
  const connector = getConnector(block.connectorId);
  if (!connector) {
    workerLog({
      worker: "sheets_refresh",
      event: "unknown_connector",
      blockId,
      connectorId: block.connectorId,
    });
    return;
  }

  // ── Stage 3: load the workbook snapshot (outside hold) ───────────────────
  const workbook = await sheetsOps.getSheetWorkbook(block.workbookId);
  if (!workbook) {
    workerLog({
      worker: "sheets_refresh",
      event: "workbook_not_found",
      blockId,
      workbookId: block.workbookId,
    });
    return;
  }

  // ── Stage 4: run connector query (outside hold) ──────────────────────────
  const userId = payload.userId ?? "system";
  const userRole = payload.userRole ?? "ceo";
  let connectorResult: { headers: string[]; rows: CellValue[][] };
  try {
    connectorResult = await connector.query(block.connectorParams, userId, userRole);
  } catch (err: any) {
    workerLog({
      worker: "sheets_refresh",
      event: "connector_error",
      blockId,
      connectorId: block.connectorId,
      error: err?.message ?? String(err),
    });
    // Write a visible error row to the block so the user can see it failed.
    connectorResult = {
      headers: ["Error"],
      rows: [[`Refresh failed: ${err?.message ?? "unknown error"}`]],
    };
  }

  // ── Stage 5: compute region rewrite (CPU only, no hold) ──────────────────
  const refreshedAt = new Date();
  const { updatedSnapshot, newRowCount, newColCount } = applyBlockToSnapshot(
    workbook.snapshot,
    {
      sheetId: block.sheetId,
      startRow: block.startRow,
      startCol: block.startCol,
      oldRowCount: block.rowCount,
      connectorLabel: connector.label,
      lastRefreshedAt: refreshedAt,
      headers: connectorResult.headers,
      rows: connectorResult.rows,
    },
  );

  // ── Stage 6: persist in a single short hold on the worker pool ──────────
  // Two writes are wrapped in one transaction so the snapshot and block
  // metadata stay consistent even if the process restarts mid-handler.
  // Using workerDb (not getDb / api pool) keeps background work off the
  // request-serving connection pool — consistent with pool-tenancy rules.
  const snapshotSizeBytes = Buffer.byteLength(JSON.stringify(updatedSnapshot), "utf8");
  const now = new Date();
  await workerDb.transaction(async (tx) => {
    await tx
      .update(sheetWorkbooks)
      .set({
        snapshot: updatedSnapshot as any,
        snapshotSizeBytes,
        updatedAt: now,
      })
      .where(eq(sheetWorkbooks.id, block.workbookId));
    await tx
      .update(sheetDataBlocks)
      .set({
        rowCount: newRowCount,
        colCount: newColCount,
        lastRefreshedAt: refreshedAt,
        updatedAt: now,
      })
      .where(eq(sheetDataBlocks.id, blockId));
  });

  workerLog({
    worker: "sheets_refresh",
    event: "refreshed",
    blockId,
    connectorId: block.connectorId,
    newRowCount,
    newColCount,
  });

}


// ─── producer: daily auto-refresh ────────────────────────────────────────────

async function runAutoRefreshTick(): Promise<void> {
  const enabled = isKillSwitchEnabled("sheets_auto_refresh_enabled");
  if (!enabled) {
    workerLog({ worker: "sheets_refresh_producer", event: "skip_kill_switch_off" });
    return;
  }

  let blocks: Awaited<ReturnType<typeof sheetsOps.listSheetDataBlocksForAutoRefresh>>;
  try {
    blocks = await sheetsOps.listSheetDataBlocksForAutoRefresh();
  } catch (err: any) {
    workerLog({
      worker: "sheets_refresh_producer",
      event: "list_error",
      error: err?.message,
    });
    return;
  }

  if (blocks.length === 0) return;

  const bucket = Math.floor(Date.now() / DATE_BUCKET_MS);
  let enqueued = 0;

  for (const block of blocks) {
    try {
      const dedupeKey = `sheets_block_refresh:${block.id}:${bucket}`;
      await enqueueJob({
        queueName: SHEETS_REFRESH_QUEUE,
        payload: { blockId: block.id, userId: "system", userRole: "ceo" },
        workloadClass: "maintenance",
        priority: 400,
        maxAttempts: 2,
        dedupeKey,
      });
      enqueued++;
    } catch (err: any) {
      workerLog({
        worker: "sheets_refresh_producer",
        event: "enqueue_error",
        blockId: block.id,
        error: err?.message,
      });
    }
  }

  if (enqueued > 0) {
    workerLog({
      worker: "sheets_refresh_producer",
      event: "enqueued",
      count: enqueued,
      bucket,
    });
  }
}

/**
 * Enqueue a one-off refresh for a single block (used by the manual-refresh
 * route and immediately after block creation).
 */
export async function enqueueSheetDataBlockRefresh(
  blockId: string,
  _userId: string,
  _userRole: string,
): Promise<void> {
  const bucket = Math.floor(Date.now() / DATE_BUCKET_MS);
  await enqueueJob({
    queueName: SHEETS_REFRESH_QUEUE,
    payload: { blockId, userId: _userId, userRole: _userRole },
    workloadClass: "maintenance",
    priority: 300,
    maxAttempts: 3,
    dedupeKey: `sheets_block_refresh:${blockId}:${bucket}:manual`,
  });
}

export function startSheetsAutoRefreshProducer(): void {
  if (producerTimer) return;
  producerTimer = setInterval(() => {
    runAutoRefreshTick().catch((err) => {
      workerLog({
        worker: "sheets_refresh_producer",
        event: "tick_error",
        error: err?.message,
      });
    });
  }, PRODUCER_INTERVAL_MS);
  workerLog({ worker: "sheets_refresh_producer", event: "started" });
}

export function stopSheetsAutoRefreshProducer(): void {
  if (producerTimer) {
    clearInterval(producerTimer);
    producerTimer = null;
  }
}
