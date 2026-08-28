// @db-pool-intent: api
/**
 * Service Desk routes — ClickUp imports & mapped-name refresh.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Import departments, Import request types, Refresh names for already-mapped options.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartments, sdRequestTypes, sdListMapping } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { extractRtPrefix, matchDeptForPrefix } from "@shared/lib/serviceDeskDeptMatcher";
import { getCeoToken, getListMappingConfig, getMergedCustomFields, refreshMappedDepartmentNames, refreshMappedRequestTypeNames } from "./helpers";

export function registerServiceDeskClickUpImportRoutes(app: Express): void {
  // ── Import departments from ClickUp Department field ────────────────────────
  // Reads the bound Department field's dropdown options from ClickUp and
  // reconciles ONLY to existing NoBull-authoritative departments. Options with
  // no mapped or name-matched local department are reported for operator review;
  // imports never create local departments, so a deleted ClickUp option cannot
  // resurrect a retired department.
  //
  // API: GET /api/v2/list/{list_id}/field — already wrapped by cu.getCustomFields.
  // Options cannot be created/edited via the public API (read-only for options).

  app.post(
    "/api/service-desk/setup/import-departments",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        const config = await getListMappingConfig();

        if (!config?.clickupListId) {
          return res.status(400).json({ error: "List not yet configured. Create the ClickUp structure first." });
        }
        if (!config.fieldDepartmentId) {
          return res.status(400).json({ error: "Department field UUID not configured. Bind it in the Config tab first." });
        }
        if (!token) {
          return res.status(400).json({ error: "ClickUp token required. Connect your ClickUp account on your Profile page." });
        }

        // Fetch custom fields from all hierarchy levels (list, folder, space, workspace) so
        // inherited fields created above the List level are also found. See getMergedCustomFields.
        const { fields: importFields, levelErrors: importLevelErrors } = await getMergedCustomFields(token, config);
        const deptField = importFields.find((f: any) => f.id === config.fieldDepartmentId) ?? null;

        function extractOptions(field: any | null): Array<{ id: string; name: string; orderindex: number }> {
          if (!field) return [];
          const opts = field?.type_config?.options ?? field?.options ?? [];
          return Array.isArray(opts)
            ? opts.map((o: any) => ({
                id: String(o.id ?? o.orderindex ?? ""),
                // Strip leading "Option N" import artifacts (e.g. "Option 1Fulfillment – GBP / Local SEO")
                name: String(o.name ?? o.label ?? "").replace(/^Option\s*\d+\s*/i, "").trim(),
                orderindex: isFinite(Number(o.orderindex)) ? Number(o.orderindex) : 0,
              }))
            : [];
        }

        const clickupOptions = extractOptions(deptField);

        if (clickupOptions.length === 0) {
          return res.status(200).json({
            matched: [],
            alreadyMapped: [],
            unknown: [],
            matchedCount: 0,
            alreadyMappedCount: 0,
            unknownCount: 0,
            note: deptField
              ? "The Department field was found but has no dropdown options. Make sure it is a Dropdown field type and options are defined in ClickUp."
              : importLevelErrors.length > 0
                ? `The Department field UUID was not found in the levels that could be checked (some levels could not be queried: ${importLevelErrors.join(", ")}). Verify your ClickUp configuration and try again.`
                : "The Department field UUID was not found at any ClickUp hierarchy level (list, folder, space, or workspace). Re-copy the field UUID from ClickUp into the Config tab.",
          });
        }

        // Load all existing NoBull departments (including inactive) for name matching
        const existingDepts = await withDbAttribution("serviceDesk:importDepts:loadDepts", async () => {
          const db = getDb();
          return db.select({ id: sdDepartments.id, name: sdDepartments.name }).from(sdDepartments);
        });

        // Existing saved map. A mapping to a deleted local department is not
        // authoritative and must not be treated as a valid binding.
        const existingMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
        const existingDeptIds = new Set(existingDepts.map((department) => department.id));
        const validExistingMap = Object.fromEntries(
          Object.entries(existingMap).filter(([, departmentId]) => existingDeptIds.has(departmentId)),
        );
        const staleMappedOptionIds = new Set(
          Object.entries(existingMap)
            .filter(([, departmentId]) => !existingDeptIds.has(departmentId))
            .map(([optionId]) => optionId),
        );

        // Refresh names of already-mapped departments whose ClickUp option was
        // renamed (mutates existingDepts entries in place, mappings untouched).
        const renamed = await refreshMappedDepartmentNames(clickupOptions, validExistingMap, existingDepts);

        // Case-insensitive name → department id lookup (post-rename names)
        const deptByName = new Map(
          existingDepts.map((d) => [d.name.toLowerCase().trim(), d.id]),
        );

        const newMap: Record<string, string> = { ...validExistingMap };

        const matched: Array<{ optionId: string; optionName: string; departmentId: string }> = [];
        const alreadyMapped: Array<{ optionId: string; optionName: string; departmentId: string }> = [];
        const unknown: Array<{ optionId: string; optionName: string; reason: "no_local_department" | "stale_mapping" }> = [];

        for (const opt of clickupOptions) {
          // Already mapped — preserve without touching
          if (validExistingMap[opt.id]) {
            alreadyMapped.push({ optionId: opt.id, optionName: opt.name, departmentId: validExistingMap[opt.id] });
            continue;
          }
          if (staleMappedOptionIds.has(opt.id)) {
            unknown.push({ optionId: opt.id, optionName: opt.name, reason: "stale_mapping" });
            continue;
          }
          // Match by case-insensitive name against existing departments
          const matchedDeptId = deptByName.get(opt.name.toLowerCase().trim()) ?? null;
          if (matchedDeptId) {
            newMap[opt.id] = matchedDeptId;
            matched.push({ optionId: opt.id, optionName: opt.name, departmentId: matchedDeptId });
          } else {
            unknown.push({ optionId: opt.id, optionName: opt.name, reason: "no_local_department" });
          }
        }

        // Persist the merged map (only if something changed)
        if (staleMappedOptionIds.size > 0 || matched.length > 0) {
          await withDbAttribution("serviceDesk:importDepts:saveMap", async () => {
            const db = getDb();
            await db.transaction(async (tx) => {
              // Department retirement locks its row before it removes option
              // mappings. Re-lock every map target here and discard anything
              // that disappeared while this import was fetching ClickUp, so a
              // stale import cannot restore a retired department UUID.
              const mappedDepartmentIds = [...new Set(Object.values(newMap))];
              const lockedDepartments = mappedDepartmentIds.length > 0
                ? await tx
                    .select({ id: sdDepartments.id })
                    .from(sdDepartments)
                    .where(inArray(sdDepartments.id, mappedDepartmentIds))
                    .for("update")
                : [];
              const liveDepartmentIds = new Set(lockedDepartments.map((department) => department.id));
              const settledMap = Object.fromEntries(
                Object.entries(newMap).filter(([, departmentId]) => liveDepartmentIds.has(departmentId)),
              );
              const [existing] = await tx
                .select({ id: sdListMapping.id })
                .from(sdListMapping)
                .limit(1)
                .for("update");
              if (existing) {
                await tx.update(sdListMapping)
                  .set({ departmentOptionIds: settledMap, updatedAt: new Date() })
                  .where(eq(sdListMapping.id, existing.id));
              }
            });
          });
        }

        res.json({
          matched,
          alreadyMapped,
          unknown,
          renamed,
          matchedCount: matched.length,
          alreadyMappedCount: alreadyMapped.length,
          unknownCount: unknown.length,
          renamedCount: renamed.length,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Import request types from ClickUp Request Type field ────────────────────
  // Mirrors import-departments: reads the bound Request Type field's dropdown
  // options from ClickUp, creates sd_request_types rows for options with no
  // NoBull match (case-insensitive name), and merges new UUID→requestTypeId
  // pairs into requestTypeOptionIds without overwriting manually-set entries.
  // Imported types get no department binding (departmentId null = global);
  // ClickUp dropdown options carry no department info.

  app.post(
    "/api/service-desk/setup/import-request-types",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        const config = await getListMappingConfig();

        if (!config?.clickupListId) {
          return res.status(400).json({ error: "List not yet configured. Create the ClickUp structure first." });
        }
        if (!config.fieldRequestTypeId) {
          return res.status(400).json({ error: "Request Type field UUID not configured. Bind it in the Config tab first." });
        }
        if (!token) {
          return res.status(400).json({ error: "ClickUp token required. Connect your ClickUp account on your Profile page." });
        }

        const { fields: importFields, levelErrors: importLevelErrors } = await getMergedCustomFields(token, config);
        const rtField = importFields.find((f: any) => f.id === config.fieldRequestTypeId) ?? null;

        function extractOptions(field: any | null): Array<{ id: string; name: string; orderindex: number }> {
          if (!field) return [];
          const opts = field?.type_config?.options ?? field?.options ?? [];
          return Array.isArray(opts)
            ? opts.map((o: any) => ({
                id: String(o.id ?? o.orderindex ?? ""),
                name: String(o.name ?? o.label ?? ""),
                orderindex: isFinite(Number(o.orderindex)) ? Number(o.orderindex) : 0,
              }))
            : [];
        }

        const clickupOptions = extractOptions(rtField);

        if (clickupOptions.length === 0) {
          return res.status(200).json({
            created: [],
            matched: [],
            alreadyMapped: [],
            createdCount: 0,
            matchedCount: 0,
            alreadyMappedCount: 0,
            note: rtField
              ? "The Request Type field was found but has no dropdown options. Make sure it is a Dropdown field type and options are defined in ClickUp."
              : importLevelErrors.length > 0
                ? `The Request Type field UUID was not found in the levels that could be checked (some levels could not be queried: ${importLevelErrors.join(", ")}). Verify your ClickUp configuration and try again.`
                : "The Request Type field UUID was not found at any ClickUp hierarchy level (list, folder, space, or workspace). Re-copy the field UUID from ClickUp into the Config tab.",
          });
        }

        // Load all existing NoBull request types (including inactive) for name matching
        const [existingRts, importDepts] = await Promise.all([
          withDbAttribution("serviceDesk:importRts:loadRts", async () => {
            const db = getDb();
            return db.select({ id: sdRequestTypes.id, name: sdRequestTypes.name }).from(sdRequestTypes);
          }),
          withDbAttribution("serviceDesk:importRts:loadDepts", async () => {
            const db = getDb();
            return db.select({ id: sdDepartments.id, name: sdDepartments.name }).from(sdDepartments).where(eq(sdDepartments.active, true));
          }),
        ]);

        // Existing saved map. A mapping whose request-type label no longer has
        // a backing row is stale and must not be counted as already mapped.
        // CONTRACT: requestTypeOptionIds values are request-type NAMES (labels),
        // not IDs — the ticket resolver and the Option Maps UI both read/write
        // labels (see resolveTickets ~line 410 and the auto-match UI).
        const existingMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;
        const existingRtNameKeys = new Set(existingRts.map((requestType) => requestType.name.toLowerCase().trim()));
        const validExistingMap = Object.fromEntries(
          Object.entries(existingMap).filter(([, requestTypeName]) =>
            existingRtNameKeys.has(requestTypeName.toLowerCase().trim()),
          ),
        );
        const staleMappedOptionIds = new Set(
          Object.entries(existingMap)
            .filter(([, requestTypeName]) => !existingRtNameKeys.has(requestTypeName.toLowerCase().trim()))
            .map(([optionId]) => optionId),
        );
        const newMap: Record<string, string> = { ...validExistingMap };

        // Refresh names of already-mapped request types whose ClickUp option was
        // renamed. Mutates newMap values (name-keyed) + existingRts in place;
        // mappings themselves (option → request type row) are never changed.
        const renamed = await refreshMappedRequestTypeNames(clickupOptions, newMap, existingRts);

        const created: Array<{ optionId: string; optionName: string; requestTypeName: string }> = [];
        const matched: Array<{ optionId: string; optionName: string; requestTypeName: string }> = [];
        const alreadyMapped: Array<{ optionId: string; optionName: string; requestTypeName: string }> = [];
        const staleRecovered: Array<{ optionId: string; optionName: string; requestTypeName: string }> = [];

        // Built AFTER the rename refresh so lookups use the current names.
        const rtByName = new Map(
          existingRts.map((r) => [r.name.toLowerCase().trim(), r.id]),
        );
        // name-key → canonical stored name, so the map value matches the
        // sd_request_types row exactly even when casing differs in ClickUp.
        const rtCanonicalName = new Map(
          existingRts.map((r) => [r.name.toLowerCase().trim(), r.name]),
        );

        for (const opt of clickupOptions) {
          if (validExistingMap[opt.id]) {
            // Report the (possibly just-refreshed) name from newMap.
            alreadyMapped.push({ optionId: opt.id, optionName: opt.name, requestTypeName: newMap[opt.id] });
            continue;
          }
          const nameKey = opt.name.toLowerCase().trim();
          const matchedRtId = rtByName.get(nameKey) ?? null;
          if (matchedRtId) {
            const canonical = rtCanonicalName.get(nameKey) ?? opt.name;
            newMap[opt.id] = canonical;
            matched.push({ optionId: opt.id, optionName: opt.name, requestTypeName: canonical });
          } else {
            // Attempt to auto-link a department via name-prefix matching so that
            // newly-imported types are immediately filtered correctly on the form
            // even before the CEO presses "Auto-match departments".
            const autoPrefix = extractRtPrefix(opt.name);
            const autoMatch = matchDeptForPrefix(autoPrefix, importDepts);
            // A stale mapping means the former request type was deliberately
            // removed. Restore the row for explicit operator remapping, but do
            // not guess its new department from a similar-looking prefix.
            const autoDeptId = staleMappedOptionIds.has(opt.id)
              ? null
              : autoMatch.kind === "matched"
                ? autoMatch.deptId
                : null;

            const [newRt] = await withDbAttribution("serviceDesk:importRts:createRt", async () => {
              const db = getDb();
              return db
                .insert(sdRequestTypes)
                .values({ name: opt.name, sortOrder: opt.orderindex, active: true, departmentId: autoDeptId })
                .returning({ id: sdRequestTypes.id, name: sdRequestTypes.name });
            });
            rtByName.set(newRt.name.toLowerCase().trim(), newRt.id);
            rtCanonicalName.set(newRt.name.toLowerCase().trim(), newRt.name);
            newMap[opt.id] = newRt.name;
            created.push({ optionId: opt.id, optionName: opt.name, requestTypeName: newRt.name });
            if (staleMappedOptionIds.has(opt.id)) {
              staleRecovered.push({ optionId: opt.id, optionName: opt.name, requestTypeName: newRt.name });
            }
          }
        }

        if (staleMappedOptionIds.size > 0 || created.length > 0 || matched.length > 0 || renamed.length > 0) {
          await withDbAttribution("serviceDesk:importRts:saveMap", async () => {
            const db = getDb();
            const [existing] = await db.select({ id: sdListMapping.id }).from(sdListMapping).limit(1);
            if (existing) {
              await db.update(sdListMapping)
                .set({ requestTypeOptionIds: newMap, updatedAt: new Date() })
                .where(eq(sdListMapping.id, existing.id));
            }
          });
        }

        res.json({
          created,
          matched,
          alreadyMapped,
          staleRecovered,
          renamed,
          createdCount: created.length,
          matchedCount: matched.length,
          alreadyMappedCount: alreadyMapped.length,
          staleRecoveredCount: staleRecovered.length,
          needsDepartmentRemapCount: staleRecovered.length,
          renamedCount: renamed.length,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Refresh names for already-mapped options (Task #3616) ───────────────────
  // Lightweight counterpart to the import endpoints for the Option Maps
  // "Auto-match by name" flow: refreshes NoBull department / request type
  // display names to match renamed ClickUp options WITHOUT creating rows or
  // adding mappings. Idempotent and safe to press repeatedly in production.

  app.post(
    "/api/service-desk/setup/refresh-option-names",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        const config = await getListMappingConfig();

        if (!config?.clickupListId) {
          return res.status(400).json({ error: "List not yet configured. Create the ClickUp structure first." });
        }
        if (!token) {
          return res.status(400).json({ error: "ClickUp token required. Connect your ClickUp account on your Profile page." });
        }

        const { fields } = await getMergedCustomFields(token, config);
        const deptField = config.fieldDepartmentId
          ? fields.find((f: any) => f.id === config.fieldDepartmentId) ?? null
          : null;
        const rtField = config.fieldRequestTypeId
          ? fields.find((f: any) => f.id === config.fieldRequestTypeId) ?? null
          : null;

        function extractOptions(field: any | null, stripArtifacts: boolean): Array<{ id: string; name: string }> {
          if (!field) return [];
          const opts = field?.type_config?.options ?? field?.options ?? [];
          return Array.isArray(opts)
            ? opts.map((o: any) => {
                const raw = String(o.name ?? o.label ?? "");
                return {
                  id: String(o.id ?? o.orderindex ?? ""),
                  // Departments strip leading "Option N" import artifacts, matching import-departments.
                  name: stripArtifacts ? raw.replace(/^Option\s*\d+\s*/i, "").trim() : raw,
                };
              })
            : [];
        }

        const deptOptions = extractOptions(deptField, true);
        const rtOptions = extractOptions(rtField, false);

        const [existingDepts, existingRts] = await Promise.all([
          withDbAttribution("serviceDesk:refreshNames:loadDepts", async () => {
            const db = getDb();
            return db.select({ id: sdDepartments.id, name: sdDepartments.name }).from(sdDepartments);
          }),
          withDbAttribution("serviceDesk:refreshNames:loadRts", async () => {
            const db = getDb();
            return db.select({ id: sdRequestTypes.id, name: sdRequestTypes.name }).from(sdRequestTypes);
          }),
        ]);

        const deptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
        const rtMap: Record<string, string> = { ...((config.requestTypeOptionIds ?? {}) as Record<string, string>) };

        const departmentsRenamed = await refreshMappedDepartmentNames(deptOptions, deptMap, existingDepts);
        const requestTypesRenamed = await refreshMappedRequestTypeNames(rtOptions, rtMap, existingRts);

        // Request-type map values are names, so renames must be persisted.
        if (requestTypesRenamed.length > 0) {
          await withDbAttribution("serviceDesk:refreshNames:saveRtMap", async () => {
            const db = getDb();
            const [existing] = await db.select({ id: sdListMapping.id }).from(sdListMapping).limit(1);
            if (existing) {
              await db.update(sdListMapping)
                .set({ requestTypeOptionIds: rtMap, updatedAt: new Date() })
                .where(eq(sdListMapping.id, existing.id));
            }
          });
        }

        res.json({
          departmentsRenamed,
          requestTypesRenamed,
          departmentsRenamedCount: departmentsRenamed.length,
          requestTypesRenamedCount: requestTypesRenamed.length,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

}
