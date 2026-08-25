// @db-pool-intent: api
/**
 * Service Desk routes — request types & ClickUp option mapping.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Request types, Setup: ClickUp dropdown options, Sync client dropdown options, Accept AI-suggested client option pairings.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo, openai } from "../middleware";
import { CHEAP_MODEL, reasoningEffortFor } from "../../aiModels";
import { normalizeFirmName } from "../../utils/firmNameNormalize";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartments, sdRequestTypes, sdListMapping } from "@shared/schema";
import { clients } from "@shared/models/clients";
import { eq, asc, isNull, or } from "drizzle-orm";
import { extractRtPrefix, matchDeptForPrefix } from "@shared/lib/serviceDeskDeptMatcher";
import { getCeoToken, getListMappingConfig, getMergedCustomFields } from "./helpers";

export function registerServiceDeskRequestTypeRoutes(app: Express): void {
  // ── Request types ──────────────────────────────────────────────────────────

  app.get("/api/service-desk/request-types", isAuthenticated, async (req: any, res) => {
    try {
      const { departmentId } = req.query as { departmentId?: string };
      const rows = await withDbAttribution("serviceDesk:listRequestTypes", async () => {
        const db = getDb();
        const q = db
          .select()
          .from(sdRequestTypes)
          .orderBy(asc(sdRequestTypes.sortOrder), asc(sdRequestTypes.name));
        if (departmentId) {
          return q.where(
            or(
              eq(sdRequestTypes.departmentId, departmentId),
              isNull(sdRequestTypes.departmentId),
            ),
          );
        }
        return q;
      });
      res.json({ requestTypes: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/service-desk/request-types", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { name, departmentId, description, sortOrder } = req.body as {
        name?: string;
        departmentId?: string;
        description?: string;
        sortOrder?: number;
      };
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const [row] = await withDbAttribution("serviceDesk:createRequestType", async () => {
        const db = getDb();
        return db
          .insert(sdRequestTypes)
          .values({
            name: name.trim(),
            departmentId: departmentId ?? null,
            description: description ?? null,
            sortOrder: sortOrder ?? 0,
          })
          .returning();
      });
      res.json({ requestType: row });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/service-desk/request-types/:id", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { name, active, departmentId, description, sortOrder } = req.body as {
        name?: string;
        active?: boolean;
        departmentId?: string | null;
        description?: string;
        sortOrder?: number;
      };
      const upd: Record<string, any> = { updatedAt: new Date() };
      if (name != null) upd.name = name;
      if (active != null) upd.active = active;
      if (departmentId !== undefined) upd.departmentId = departmentId;
      if (description !== undefined) upd.description = description;
      if (sortOrder != null) upd.sortOrder = sortOrder;
      const [row] = await withDbAttribution("serviceDesk:updateRequestType", async () => {
        const db = getDb();
        return db.update(sdRequestTypes).set(upd).where(eq(sdRequestTypes.id, id)).returning();
      });
      if (!row) return res.status(404).json({ error: "Request type not found" });
      res.json({ requestType: row });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(
    "/api/service-desk/request-types/:id",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { id } = req.params;
        await withDbAttribution("serviceDesk:deactivateRequestType", async () => {
          const db = getDb();
          await db
            .update(sdRequestTypes)
            .set({ active: false, updatedAt: new Date() })
            .where(eq(sdRequestTypes.id, id));
        });
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Auto-match request types to departments by name prefix (Task #3550) ────
  // POST with { dryRun: true }  → preview matched/unmatched without writing.
  // POST with { dryRun: false, matches: [{requestTypeId, departmentId}] } → apply.
  //
  // Matching algorithm:
  //   1. Extract the prefix from each RT name (text before the first " – " or " - ").
  //   2. Strip leading "Option N" artifact from department names.
  //   3. Parse each dept name into group + label (e.g. "Fulfillment – GBP / Local SEO").
  //   4. For each RT prefix, try (in order):
  //      a. Exact match against dept label (normalised, lower-case, trimmed).
  //      b. Dept label contains RT prefix, or RT prefix contains dept label.
  //      c. Dept full name contains RT prefix.
  //   5. Multiple matches → unassigned (surfaced for manual review).
  //   6. Already-assigned types are skipped (not re-matched).

  app.post(
    "/api/service-desk/request-types/auto-match-departments",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { dryRun = true, matches: applyMatches } = req.body as {
          dryRun?: boolean;
          matches?: Array<{ requestTypeId: string; departmentId: string }>;
        };

        if (!dryRun && Array.isArray(applyMatches)) {
          await withDbAttribution("serviceDesk:autoMatchDepts:apply", async () => {
            const db = getDb();
            for (const m of applyMatches) {
              await db
                .update(sdRequestTypes)
                .set({ departmentId: m.departmentId, updatedAt: new Date() })
                .where(eq(sdRequestTypes.id, m.requestTypeId));
            }
          });
          return res.json({ success: true, appliedCount: applyMatches.length });
        }

        const [rts, depts] = await Promise.all([
          withDbAttribution("serviceDesk:autoMatchDepts:rts", async () => {
            const db = getDb();
            return db.select().from(sdRequestTypes).where(eq(sdRequestTypes.active, true));
          }),
          withDbAttribution("serviceDesk:autoMatchDepts:depts", async () => {
            const db = getDb();
            return db.select().from(sdDepartments).where(eq(sdDepartments.active, true));
          }),
        ]);

        type MatchedRow = {
          requestTypeId: string;
          requestTypeName: string;
          prefix: string;
          departmentId: string;
          departmentName: string;
          reason: string;
        };
        type UnmatchedRow = {
          requestTypeId: string;
          requestTypeName: string;
          prefix: string;
          reason: "no_match" | "ambiguous" | "already_assigned";
        };

        const matched: MatchedRow[] = [];
        const unmatched: UnmatchedRow[] = [];

        for (const rt of rts) {
          if (rt.departmentId) {
            unmatched.push({
              requestTypeId: rt.id,
              requestTypeName: rt.name,
              prefix: extractRtPrefix(rt.name),
              reason: "already_assigned",
            });
            continue;
          }
          const prefix = extractRtPrefix(rt.name);
          const result = matchDeptForPrefix(prefix, depts);
          if (result.kind === "no_match") {
            unmatched.push({ requestTypeId: rt.id, requestTypeName: rt.name, prefix, reason: "no_match" });
          } else if (result.kind === "ambiguous") {
            unmatched.push({ requestTypeId: rt.id, requestTypeName: rt.name, prefix, reason: "ambiguous" });
          } else {
            const dept = depts.find((d) => d.id === result.deptId)!;
            matched.push({
              requestTypeId: rt.id,
              requestTypeName: rt.name,
              prefix,
              departmentId: result.deptId,
              departmentName: dept.name,
              reason: result.reason,
            });
          }
        }

        res.json({ matched, unmatched });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Setup: ClickUp dropdown options for Department / Request Type fields ────
  // Returns ClickUp option UUIDs + names for the configured Dept/RT fields so
  // the admin can bind each option UUID to a NoBull department/request-type.

  app.get("/api/service-desk/setup/options", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const token = await getCeoToken(req);
      const config = await getListMappingConfig();

      if (!config?.clickupListId) {
        return res.status(400).json({ error: "List not yet configured" });
      }
      if (!token) {
        return res.status(400).json({ error: "ClickUp token required" });
      }

      const { fields: optionFields } = await getMergedCustomFields(token, config);
      const deptField = config.fieldDepartmentId
        ? optionFields.find((f: any) => f.id === config.fieldDepartmentId)
        : null;
      const rtField = config.fieldRequestTypeId
        ? optionFields.find((f: any) => f.id === config.fieldRequestTypeId)
        : null;

      function extractOptions(field: any | null): Array<{ id: string; name: string }> {
        if (!field) return [];
        // ClickUp dropdown/label fields store options as field.type_config.options
        const opts = field?.type_config?.options ?? field?.options ?? [];
        return Array.isArray(opts)
          ? opts.map((o: any) => ({ id: String(o.id ?? o.orderindex ?? ""), name: String(o.name ?? o.label ?? "") }))
          : [];
      }

      const savedDeptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
      const savedRtMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;
      const savedClientMap = (config.clientOptionIds ?? {}) as Record<string, string>;

      const deptOptions = extractOptions(deptField).map((o) => ({
        ...o,
        nobullDepartmentId: savedDeptMap[o.id] ?? null,
      }));
      const rtOptions = extractOptions(rtField).map((o) => ({
        ...o,
        nobullRequestTypeId: savedRtMap[o.id] ?? null,
      }));

      // Client field options (if bound)
      const clientField = config.fieldClientId
        ? optionFields.find((f: any) => f.id === config.fieldClientId)
        : null;
      const clientOptions = extractOptions(clientField).map((o) => ({
        ...o,
        nobullClientId: savedClientMap[o.id] ?? null,
      }));

      res.json({ options: { department: deptOptions, requestType: rtOptions, client: clientOptions } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sync client dropdown options ────────────────────────────────────────────
  // Pulls the Client field's dropdown options from ClickUp, auto-matches option
  // labels to NoBull clients by firm name (case-insensitive), persists the map,
  // and returns the match result + gaps for admin review.
  //
  // API (ClickUp): GET /api/v2/list/{list_id}/field — already wrapped by getCustomFields.
  // The public API cannot CREATE or EDIT dropdown options; option creation is manual in ClickUp.

  app.post(
    "/api/service-desk/setup/sync-client-options",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        const config = await getListMappingConfig();

        if (!config?.clickupListId) {
          return res.status(400).json({ error: "List not yet configured" });
        }
        if (!config.fieldClientId) {
          return res.status(400).json({ error: "Client field UUID not configured. Bind it in the Config tab first." });
        }
        if (!token) {
          return res.status(400).json({ error: "ClickUp token required. Connect your ClickUp account on your Profile page." });
        }

        // Fetch all custom fields from all hierarchy levels for the bound list
        const { fields: clientFields } = await getMergedCustomFields(token, config);
        const clientField = clientFields.find((f: any) => f.id === config.fieldClientId) ?? null;

        // Extract options from the field's type_config
        function extractOptions(field: any | null): Array<{ id: string; name: string }> {
          if (!field) return [];
          const opts = field?.type_config?.options ?? field?.options ?? [];
          return Array.isArray(opts)
            ? opts.map((o: any) => ({ id: String(o.id ?? o.orderindex ?? ""), name: String(o.name ?? o.label ?? "") }))
            : [];
        }

        const clickupOptions = extractOptions(clientField);

        if (clickupOptions.length === 0) {
          return res.status(200).json({
            matched: [],
            unmatchedOptions: [],
            clientsWithoutOption: [],
            savedMap: {},
            note: clientField
              ? "The Client field was found but has no dropdown options. Make sure it is a Dropdown field type and options are defined in ClickUp."
              : "The Client field UUID was not found on the bound ClickUp List. Re-copy the field UUID from ClickUp into the Config tab.",
          });
        }

        // Load all active NoBull clients for firm-name auto-matching.
        // Task #4330: customers only — prospect/lead records never become
        // ClickUp client options.
        const allNobullClients = await withDbAttribution("serviceDesk:syncClientOptions:loadClients", async () => {
          const db = getDb();
          return db.select({ id: clients.id, firmName: clients.firmName }).from(clients).where(eq(clients.lifecycleStage, "customer")).orderBy(asc(clients.firmName));
        });

        // ── Tier-1 deterministic lookup maps ─────────────────────────────────
        // Exact: lowercase firm name → clientId
        const clientByExact = new Map(
          allNobullClients.map((c) => [c.firmName.toLowerCase().trim(), c.id]),
        );

        // Normalized: normalizeFirmName(firmName) → [clientId, ...] (detect ambiguity)
        const clientByNorm = new Map<string, string[]>();
        for (const c of allNobullClients) {
          const norm = normalizeFirmName(c.firmName);
          if (!clientByNorm.has(norm)) clientByNorm.set(norm, []);
          clientByNorm.get(norm)!.push(c.id);
        }

        // Existing saved map: used to carry over manual pairings, but only if the option UUID
        // still exists in the current ClickUp options list. Stale UUIDs (removed/recreated options)
        // are dropped so they can't produce invalid option IDs on submission.
        const existingMap = (config.clientOptionIds ?? {}) as Record<string, string>;
        const newMap: Record<string, string> = {};

        const matched: Array<{ optionId: string; optionName: string; clientId: string; firmName: string; autoMatched: boolean }> = [];
        const unmatchedOptions: Array<{ optionId: string; optionName: string }> = [];

        for (const opt of clickupOptions) {
          const existingClientId = existingMap[opt.id];
          if (existingClientId) {
            // Carry over existing mapping (auto or manual) since the option UUID still exists
            const client = allNobullClients.find((c) => c.id === existingClientId);
            newMap[opt.id] = existingClientId;
            matched.push({ optionId: opt.id, optionName: opt.name, clientId: existingClientId, firmName: client?.firmName ?? existingClientId, autoMatched: false });
            continue;
          }

          // Tier-1a: exact case-insensitive firm-name match
          const exactId = clientByExact.get(opt.name.toLowerCase().trim()) ?? null;
          if (exactId) {
            newMap[opt.id] = exactId;
            const client = allNobullClients.find((c) => c.id === exactId);
            matched.push({ optionId: opt.id, optionName: opt.name, clientId: exactId, firmName: client?.firmName ?? exactId, autoMatched: true });
            continue;
          }

          // Tier-1b: normalized match — auto-apply only when unambiguous (one candidate)
          const normOptName = normalizeFirmName(opt.name);
          const normCandidates = clientByNorm.get(normOptName) ?? [];
          if (normCandidates.length === 1) {
            const normId = normCandidates[0];
            newMap[opt.id] = normId;
            const client = allNobullClients.find((c) => c.id === normId);
            matched.push({ optionId: opt.id, optionName: opt.name, clientId: normId, firmName: client?.firmName ?? normId, autoMatched: true });
            continue;
          }

          unmatchedOptions.push({ optionId: opt.id, optionName: opt.name });
        }

        // Clients that have no ClickUp option (after deterministic matching)
        const mappedClientIds = new Set(Object.values(newMap));
        const clientsWithoutOption = allNobullClients.filter((c) => !mappedClientIds.has(c.id));

        // Build a name map (optionUUID → optionName) for ALL options (mapped + unmatched)
        // so the submission form can display labels without a live ClickUp API call.
        const nameMap: Record<string, string> = {};
        for (const opt of clickupOptions) {
          nameMap[opt.id] = opt.name;
        }

        // Persist the deterministically-matched map + name map
        await withDbAttribution("serviceDesk:syncClientOptions:save", async () => {
          const db = getDb();
          const [existing] = await db.select({ id: sdListMapping.id }).from(sdListMapping).limit(1);
          if (existing) {
            await db.update(sdListMapping)
              .set({ clientOptionIds: newMap, clientOptionNames: nameMap, updatedAt: new Date() })
              .where(eq(sdListMapping.id, existing.id));
          }
        });

        // ── Tier-2: AI suggestion pass ────────────────────────────────────────
        // Batch unmatched options + unmapped clients into a single AI call.
        // Suggestions are returned in the response but NOT persisted until the
        // admin accepts them via POST /api/service-desk/setup/accept-client-suggestions.
        // Failure degrades gracefully: sync still completes with deterministic results.
        type AiSuggestion = { optionId: string; optionName: string; clientId: string; firmName: string };
        let suggestions: AiSuggestion[] = [];
        let suggestionsNote: string | undefined;

        const unmappedClients = clientsWithoutOption.filter((c) =>
          // Only unmapped clients are eligible for AI suggestion
          !mappedClientIds.has(c.id),
        );

        if (unmatchedOptions.length > 0 && unmappedClients.length > 0) {
          try {
            const effort = reasoningEffortFor(CHEAP_MODEL);
            const completion = await openai.chat.completions.create({
              model: CHEAP_MODEL,
              ...(effort ? { reasoning_effort: effort } : {}),
              max_completion_tokens: 1500,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a firm-name matching assistant for a legal-marketing platform. " +
                    "Given a list of ClickUp client option names and NoBull firm names, identify pairs that are very likely the same firm despite minor label differences (abbreviations, punctuation, legal suffixes, spacing). " +
                    "Return ONLY a JSON array of objects with keys optionId and clientId. " +
                    "Include only high-confidence pairs — omit any option you are not confident about. " +
                    "Do not match an option to more than one client or vice versa. " +
                    'Example: [{"optionId":"abc","clientId":"xyz"}]',
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    options: unmatchedOptions.map((o) => ({ id: o.optionId, name: o.optionName })),
                    clients: unmappedClients.map((c) => ({ id: c.id, name: c.firmName })),
                  }),
                },
              ],
            });

            const rawText = completion.choices[0]?.message?.content ?? "[]";
            // Extract JSON array from the response (strip any surrounding prose)
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            const pairs: Array<{ optionId: string; clientId: string }> = jsonMatch
              ? (JSON.parse(jsonMatch[0]) as Array<{ optionId: string; clientId: string }>)
              : [];

            const unmatchedOptSet = new Set(unmatchedOptions.map((o) => o.optionId));
            const unmappedClientSet = new Set(unmappedClients.map((c) => c.id));
            const usedClientIds = new Set<string>();

            for (const pair of pairs) {
              if (
                typeof pair.optionId !== "string" ||
                typeof pair.clientId !== "string" ||
                !unmatchedOptSet.has(pair.optionId) ||
                !unmappedClientSet.has(pair.clientId) ||
                usedClientIds.has(pair.clientId)
              ) {
                continue; // Skip invalid, hallucinated, or duplicate suggestions
              }
              const client = allNobullClients.find((c) => c.id === pair.clientId);
              suggestions.push({
                optionId: pair.optionId,
                optionName: nameMap[pair.optionId] ?? pair.optionId,
                clientId: pair.clientId,
                firmName: client?.firmName ?? pair.clientId,
              });
              usedClientIds.add(pair.clientId);
            }
          } catch (aiErr: any) {
            console.warn("[ServiceDesk] syncClientOptions: AI suggestion pass failed —", aiErr?.message ?? aiErr);
            suggestionsNote = "AI suggestions unavailable — suggestions skipped. Deterministic results are complete.";
          }
        }

        res.json({
          matched,
          unmatchedOptions,
          clientsWithoutOption: clientsWithoutOption.map((c) => ({ clientId: c.id, firmName: c.firmName })),
          savedMap: newMap,
          autoMatchedCount: matched.filter((m) => m.autoMatched).length,
          suggestions,
          suggestionsNote,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Accept AI-suggested client option pairings ──────────────────────────────
  // Persists a set of admin-accepted AI suggestions into the option map without
  // overwriting any existing (manual or auto-matched) entries.
  // Body: { pairs: Array<{ optionId: string; clientId: string }> }

  app.post(
    "/api/service-desk/setup/accept-client-suggestions",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { pairs } = req.body ?? {};
        if (!Array.isArray(pairs) || pairs.length === 0) {
          return res.status(400).json({ error: "pairs must be a non-empty array of { optionId, clientId }" });
        }

        const config = await getListMappingConfig();
        if (!config) {
          return res.status(400).json({ error: "List mapping not configured" });
        }

        const existingMap = (config.clientOptionIds ?? {}) as Record<string, string>;
        const newMap: Record<string, string> = { ...existingMap };
        let accepted = 0;

        for (const pair of pairs) {
          const { optionId, clientId } = pair ?? {};
          if (typeof optionId !== "string" || typeof clientId !== "string") continue;
          if (!optionId.trim() || !clientId.trim()) continue;
          // Never overwrite an existing confirmed mapping
          if (!newMap[optionId]) {
            newMap[optionId] = clientId;
            accepted++;
          }
        }

        await withDbAttribution("serviceDesk:acceptClientSuggestions:save", async () => {
          const db = getDb();
          const [existing] = await db.select({ id: sdListMapping.id }).from(sdListMapping).limit(1);
          if (existing) {
            await db.update(sdListMapping)
              .set({ clientOptionIds: newMap, updatedAt: new Date() })
              .where(eq(sdListMapping.id, existing.id));
          }
        });

        res.json({ accepted, savedMap: newMap });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

}
