// @db-pool-intent: api
/**
 * Service Desk routes — reporting & CSV export.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Reporting, CSV export, Allowed transitions read.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireTeamLead } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartments, sdTicketMapping, sdTicketEvents, clickupTasks } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getListMappingConfig } from "./helpers";
import { TRANSITIONS } from "./workflowShared";

export function registerServiceDeskReportRoutes(app: Express): void {
  // ─── Reporting ─────────────────────────────────────────────────────────────
  // GET /api/service-desk/reports?days=30
  //   or ?from=<epochMs>&to=<epochMs>
  //
  // Returns aggregate analytics from the local mirror — no live ClickUp calls.
  // Gated to team lead and above (same audience that manages tickets).
  //
  // Unmapped tickets (no resolved department/requestType) appear in "Unmapped"
  // buckets so totals always reconcile.

  // Shared range parser for the reports + export endpoints.
  // Returns null (after writing a 400) when the range is invalid.
  function parseReportRange(req: any, res: any): { rangeStartMs: number; rangeEndMs: number } | null {
    const { days, from, to } = req.query as { days?: string; from?: string; to?: string };
    const nowMs = Date.now();
    let rangeStartMs: number;
    let rangeEndMs: number = nowMs;

    if (from && to) {
      rangeStartMs = Number(from);
      rangeEndMs = Number(to);
      if (isNaN(rangeStartMs) || isNaN(rangeEndMs) || rangeStartMs >= rangeEndMs) {
        res.status(400).json({ error: "Invalid from/to range" });
        return null;
      }
    } else {
      const daysN = Math.min(Math.max(Number(days ?? "30"), 1), 365);
      rangeStartMs = nowMs - daysN * 86_400_000;
    }
    return { rangeStartMs, rangeEndMs };
  }

  // Computes the full report payload from the local mirror for the given range.
  // Used by both the JSON reports endpoint and the CSV export endpoint.
  async function computeServiceDeskReport(
    config: NonNullable<Awaited<ReturnType<typeof getListMappingConfig>>>,
    rangeStartMs: number,
    rangeEndMs: number,
  ) {
    const nowMs = Date.now();
      const [tasks, departments] = await Promise.all([
        withDbAttribution("serviceDesk:reports:tasks", async () => {
          const db = getDb();
          return db.select().from(clickupTasks).where(eq(clickupTasks.listId, config.clickupListId!));
        }),
        withDbAttribution("serviceDesk:reports:depts", async () => {
          const db = getDb();
          return db.select({ id: sdDepartments.id, name: sdDepartments.name }).from(sdDepartments);
        }),
      ]);

      const taskIds = tasks.map((t) => t.id);

      const [mappings, commitEvents] = await Promise.all([
        taskIds.length
          ? withDbAttribution("serviceDesk:reports:mappings", async () => {
              const db = getDb();
              return db.select().from(sdTicketMapping).where(inArray(sdTicketMapping.clickupTaskId, taskIds));
            })
          : Promise.resolve([]),
        taskIds.length
          ? withDbAttribution("serviceDesk:reports:commitEvents", async () => {
              const db = getDb();
              return db
                .select()
                .from(sdTicketEvents)
                .where(
                  and(
                    inArray(sdTicketEvents.clickupTaskId, taskIds),
                    eq(sdTicketEvents.eventType, "committed_date_change"),
                  ),
                );
            })
          : Promise.resolve([]),
      ]);

      const mappingByTaskId = new Map(mappings.map((m) => [m.clickupTaskId, m]));
      const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
      const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
      const rtOptMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;

      const TERMINAL_SET = new Set(["closed", "canceled", "duplicate", "out of scope"]);

      function resolveForAnalytics(task: (typeof tasks)[0]) {
        const mapping = mappingByTaskId.get(task.id);
        const cfs: any[] = Array.isArray(task.customFields) ? (task.customFields as any[]) : [];

        function findCf(fieldId: string | null | undefined): any | null {
          if (!fieldId) return null;
          return cfs.find((cf: any) => cf.id === fieldId) ?? null;
        }
        function extractOptionId(fieldId: string | null | undefined): string | null {
          const cf = findCf(fieldId);
          if (!cf || cf.value == null) return null;
          const v = cf.value;
          if (typeof v === "string") return v;
          if (typeof v === "object" && v !== null && typeof v.id === "string") return v.id;
          if (Array.isArray(v) && v.length > 0) {
            const first = v[0];
            if (typeof first === "string") return first;
            if (typeof first === "object" && first !== null && typeof first.id === "string") return first.id;
          }
          return null;
        }
        function extractText(fieldId: string | null | undefined): string | null {
          const cf = findCf(fieldId);
          if (!cf || cf.value == null) return null;
          return String(cf.value);
        }

        const deptOptionId = extractOptionId(config.fieldDepartmentId);
        const clickupDeptId = deptOptionId ? (deptOptMap[deptOptionId] ?? null) : null;
        const departmentId = clickupDeptId ?? mapping?.departmentId ?? null;
        const departmentName = departmentId ? (deptNameById.get(departmentId) ?? "Unmapped") : "Unmapped";

        const rtOptionId = extractOptionId(config.fieldRequestTypeId);
        const requestType =
          rtOptionId
            ? (rtOptMap[rtOptionId] ?? extractText(config.fieldRequestTypeId) ?? "Unmapped")
            : (extractText(config.fieldRequestTypeId) ?? "Unmapped");

        const committedDateStr = extractText(config.fieldCommittedDateId);
        const committedMs = committedDateStr ? Number(committedDateStr) : null;

        const createdMs = task.dateCreated ? Number(task.dateCreated) : null;
        const doneMs = task.dateDone ? Number(task.dateDone) : null;
        const status = (task.status ?? "").toLowerCase().trim();

        const assigneeNames = Array.isArray(task.assignees)
          ? (task.assignees as any[])
              .map((a: any) => String(a?.username ?? a?.email ?? "").trim())
              .filter((n: string) => n.length > 0)
          : [];

        return {
          id: task.id,
          name: task.name,
          status,
          priority: task.priorityName ?? "No Priority",
          departmentId,
          departmentName,
          requestType,
          createdMs: createdMs && !isNaN(createdMs) ? createdMs : null,
          doneMs: doneMs && !isNaN(doneMs) ? doneMs : null,
          committedMs: committedMs && !isNaN(committedMs) ? committedMs : null,
          assigneeNames,
          isTerminal: TERMINAL_SET.has(status),
          clientName: extractText(config.fieldClientId) ?? null,
        };
      }

      const allResolved = tasks.map(resolveForAnalytics);

      const inRange = allResolved.filter(
        (t) => t.createdMs !== null && t.createdMs >= rangeStartMs && t.createdMs <= rangeEndMs,
      );
      const closedInRange = allResolved.filter(
        (t) => t.doneMs !== null && t.doneMs >= rangeStartMs && t.doneMs <= rangeEndMs && t.isTerminal,
      );
      const openBacklog = allResolved.filter((t) => !t.isTerminal);

      const created = inRange.length;
      const closed = closedInRange.length;
      const openBacklogCount = openBacklog.length;

      // Time-to-resolve: created → dateDone for tickets closed in range
      const ttrValues = closedInRange
        .filter((t) => t.createdMs !== null && t.doneMs !== null)
        .map((t) => t.doneMs! - t.createdMs!);

      const avgTtrMs =
        ttrValues.length > 0 ? ttrValues.reduce((s, v) => s + v, 0) / ttrValues.length : null;
      const medianTtrMs =
        ttrValues.length > 0
          ? (() => {
              const sorted = [...ttrValues].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
            })()
          : null;

      // Grouped breakdown helper
      function groupBy<T extends { id: string }>(
        arr: T[],
        key: (item: T) => string,
      ): Record<string, T[]> {
        const result: Record<string, T[]> = {};
        for (const item of arr) {
          const k = key(item);
          if (!result[k]) result[k] = [];
          result[k].push(item);
        }
        return result;
      }

      function avgTtr(items: ReturnType<typeof resolveForAnalytics>[]): number | null {
        const vals = items
          .filter((t) => t.createdMs !== null && t.doneMs !== null)
          .map((t) => t.doneMs! - t.createdMs!);
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      }

      const closedInRangeById = new Map(closedInRange.map((t) => [t.id, t]));

      function buildBreakdown(groupedAll: Record<string, ReturnType<typeof resolveForAnalytics>[]>) {
        return Object.entries(groupedAll)
          .map(([name, items]) => {
            const closedItems = items.filter((t) => closedInRangeById.has(t.id));
            return {
              name,
              count: items.length,
              closed: closedItems.length,
              avgTtrMs: avgTtr(closedItems),
            };
          })
          .sort((a, b) => b.count - a.count);
      }

      const byDepartment = buildBreakdown(groupBy(inRange, (t) => t.departmentName));
      const byRequestType = buildBreakdown(groupBy(inRange, (t) => t.requestType));
      const byPriority = buildBreakdown(groupBy(inRange, (t) => t.priority));

      // By assignee: a ticket with multiple assignees counts once per assignee,
      // so per-assignee rows reflect each person's workload (totals may exceed
      // the ticket count). Tickets with no assignees land in "Unassigned".
      const assigneeGroups: Record<string, ReturnType<typeof resolveForAnalytics>[]> = {};
      for (const t of inRange) {
        const keys = t.assigneeNames.length > 0 ? t.assigneeNames : ["Unassigned"];
        for (const k of keys) {
          if (!assigneeGroups[k]) assigneeGroups[k] = [];
          assigneeGroups[k].push(t);
        }
      }
      const byAssignee = buildBreakdown(assigneeGroups);

      // Status flow — current status of ALL tickets in this list
      const statusFlowGroups = groupBy(allResolved, (t) => t.status);
      const statusFlow = Object.entries(statusFlowGroups)
        .map(([status, items]) => ({ status, count: items.length }))
        .sort((a, b) => b.count - a.count);

      // Aging: open tickets bucketed by age
      const AGING_BUCKETS = [
        { label: "<1d", minMs: 0, maxMs: 86_400_000 },
        { label: "1–3d", minMs: 86_400_000, maxMs: 3 * 86_400_000 },
        { label: "3–7d", minMs: 3 * 86_400_000, maxMs: 7 * 86_400_000 },
        { label: "7–14d", minMs: 7 * 86_400_000, maxMs: 14 * 86_400_000 },
        { label: ">14d", minMs: 14 * 86_400_000, maxMs: Infinity },
      ];

      const aging = AGING_BUCKETS.map((bucket) => ({
        label: bucket.label,
        count: openBacklog.filter((t) => {
          if (t.createdMs === null) return false;
          const ageMs = nowMs - t.createdMs;
          return ageMs >= bucket.minMs && ageMs < bucket.maxMs;
        }).length,
      }));

      const oldestOpen = openBacklog
        .filter((t) => t.createdMs !== null)
        .sort((a, b) => a.createdMs! - b.createdMs!)
        .slice(0, 10)
        .map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          departmentName: t.departmentName,
          requestType: t.requestType,
          createdMs: t.createdMs,
          ageMs: nowMs - t.createdMs!,
        }));

      // Commitment performance
      const closedWithCommit = closedInRange.filter(
        (t) => t.committedMs !== null && t.doneMs !== null,
      );
      const onTime = closedWithCommit.filter((t) => t.doneMs! <= t.committedMs!).length;
      const onTimePercent =
        closedWithCommit.length > 0
          ? Math.round((onTime / closedWithCommit.length) * 100)
          : null;

      const slipCount = commitEvents.filter((e) => {
        const data = (e.data ?? {}) as any;
        return (
          data.isMovingLater === true &&
          e.createdAt.getTime() >= rangeStartMs &&
          e.createdAt.getTime() <= rangeEndMs
        );
      }).length;

      const overdueCount = openBacklog.filter(
        (t) => t.committedMs !== null && t.committedMs < nowMs,
      ).length;

      // Volume trend: daily/weekly buckets across the range
      const DAY_MS = 86_400_000;
      const rangeDays = Math.ceil((rangeEndMs - rangeStartMs) / DAY_MS);
      const bucketSizeMs = rangeDays <= 14 ? DAY_MS : rangeDays <= 60 ? 7 * DAY_MS : 14 * DAY_MS;

      const volumeTrend: Array<{ startMs: number; created: number; closed: number }> = [];
      let cursor = rangeStartMs;
      while (cursor < rangeEndMs) {
        const bucketEnd = Math.min(cursor + bucketSizeMs, rangeEndMs);
        volumeTrend.push({
          startMs: cursor,
          created: allResolved.filter(
            (t) => t.createdMs !== null && t.createdMs >= cursor && t.createdMs < bucketEnd,
          ).length,
          closed: allResolved.filter(
            (t) =>
              t.doneMs !== null && t.doneMs >= cursor && t.doneMs < bucketEnd && t.isTerminal,
          ).length,
        });
        cursor = bucketEnd;
      }

      return {
        configured: true as const,
        dateRange: { fromMs: rangeStartMs, toMs: rangeEndMs },
        volume: { created, closed, openBacklog: openBacklogCount, trend: volumeTrend },
        timeToResolve: { avgMs: avgTtrMs, medianMs: medianTtrMs, sampleCount: ttrValues.length },
        breakdowns: { byDepartment, byRequestType, byPriority, byAssignee },
        aging,
        oldestOpen,
        commitment: { onTimePercent, slipCount, overdueCount },
        statusFlow,
      };
  }

  app.get("/api/service-desk/reports", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.json({ configured: false, report: null });
      }
      const range = parseReportRange(req, res);
      if (!range) return;
      const report = await computeServiceDeskReport(config, range.rangeStartMs, range.rangeEndMs);
      return res.json(report);
    } catch (err: any) {
      console.error("[ServiceDesk] reports error:", err?.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── CSV export ────────────────────────────────────────────────────────────
  // GET /api/service-desk/reports/export?days=30  (or ?from=&to=)
  //
  // Flat CSV containing summary KPIs, the three breakdown tables, aging
  // distribution, status distribution, and the oldest-open table. Same
  // date-range params and team-lead gate as the JSON reports endpoint.

  function csvEscape(value: unknown): string {
    let s = value === null || value === undefined ? "" : String(value);
    // Formula-injection hardening: neutralize cells spreadsheet apps would
    // evaluate as formulas by prefixing a single quote.
    if (/^[=+\-@]/.test(s)) {
      s = `'${s}`;
    }
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function csvHours(ms: number | null): string {
    if (ms === null) return "";
    return (ms / 3_600_000).toFixed(1);
  }

  app.get("/api/service-desk/reports/export", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const config = await getListMappingConfig();
      if (!config?.clickupListId) {
        return res.status(400).json({ error: "Service Desk not configured" });
      }
      const range = parseReportRange(req, res);
      if (!range) return;
      const report = await computeServiceDeskReport(config, range.rangeStartMs, range.rangeEndMs);

      const lines: string[] = [];
      const row = (...cells: unknown[]) => lines.push(cells.map(csvEscape).join(","));

      const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

      row("Service Desk Report");
      row("Date range", fmtDate(report.dateRange.fromMs), fmtDate(report.dateRange.toMs));
      row();

      row("Summary");
      row("Metric", "Value");
      row("Created in period", report.volume.created);
      row("Closed in period", report.volume.closed);
      row("Open backlog", report.volume.openBacklog);
      row("Avg TTR (hours)", csvHours(report.timeToResolve.avgMs));
      row("Median TTR (hours)", csvHours(report.timeToResolve.medianMs));
      row("TTR sample count", report.timeToResolve.sampleCount);
      row("On-time %", report.commitment.onTimePercent ?? "");
      row("Committed-date slips", report.commitment.slipCount);
      row("Overdue open tickets", report.commitment.overdueCount);
      row();

      const breakdownSection = (
        title: string,
        rows: Array<{ name: string; count: number; closed: number; avgTtrMs: number | null }>,
      ) => {
        row(title);
        row("Name", "Created", "Closed", "Avg TTR (hours)");
        for (const r of rows) {
          row(r.name, r.count, r.closed, csvHours(r.avgTtrMs));
        }
        row();
      };

      breakdownSection("Breakdown: By Department", report.breakdowns.byDepartment);
      breakdownSection("Breakdown: By Request Type", report.breakdowns.byRequestType);
      breakdownSection("Breakdown: By Priority", report.breakdowns.byPriority);

      row("Open Ticket Aging");
      row("Age bucket", "Open tickets");
      for (const bucket of report.aging) {
        row(bucket.label, bucket.count);
      }
      row();

      row("Current Status Distribution");
      row("Status", "Tickets");
      for (const s of report.statusFlow) {
        row(s.status, s.count);
      }
      row();

      row("Oldest Open Tickets");
      row("Ticket ID", "Name", "Status", "Department", "Request Type", "Created", "Age (hours)");
      for (const t of report.oldestOpen) {
        row(
          t.id,
          t.name,
          t.status,
          t.departmentName,
          t.requestType,
          t.createdMs !== null ? fmtDate(t.createdMs) : "",
          csvHours(t.ageMs),
        );
      }

      const csv = lines.join("\r\n") + "\r\n";
      const filename = `service-desk-report_${fmtDate(report.dateRange.fromMs)}_${fmtDate(report.dateRange.toMs)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(csv);
    } catch (err: any) {
      console.error("[ServiceDesk] reports export error:", err?.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Allowed transitions read ──────────────────────────────────────────────
  // Returns the list of allowed next statuses for the given ticket.

  app.get("/api/service-desk/tickets/:taskId/allowed-transitions", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const [taskRow] = await withDbAttribution("serviceDesk:allowedTransitions:read", async () => {
        const db = getDb();
        return db.select({ status: clickupTasks.status }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });
      const currentStatus = (taskRow?.status ?? "").toLowerCase().trim();
      const allowed = TRANSITIONS[currentStatus] ?? [];
      res.json({ currentStatus, allowed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
