// @db-pool-intent: api
/**
 * Service Desk routes — config & ClickUp setup.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Config, Setup: create Space/Folder/List, Setup: auto-fill custom field UUIDs, Setup: verify checklist.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartments, sdListMapping, insertSdListMappingSchema } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import * as cu from "../../services/clickUpClient";
import { getListMappingConfig, WAITING_FIELD_BINDINGS, getCeoToken, getMergedCustomFields, findStaleWaitingFieldBindings } from "./helpers";

export function registerServiceDeskConfigSetupRoutes(app: Express): void {
  // ── Config ─────────────────────────────────────────────────────────────────

  app.get("/api/service-desk/config", isAuthenticated, async (_req, res) => {
    try {
      const config = await getListMappingConfig();
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/service-desk/config", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const existing = await getListMappingConfig();
      // Strip non-config fields (id/createdAt/updatedAt come back from GET as
      // strings and would crash Drizzle's timestamp serialization).
      const parsed = insertSdListMappingSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid config" });
      }
      const saveResult = await withDbAttribution("serviceDesk:upsertConfig", async () => {
        const db = getDb();
        return db.transaction(async (tx) => {
          // A department hard-delete locks the department rows before removing
          // their option-map bindings. Take the same locks before accepting a
          // manually supplied map, so a stale settings tab can neither restore
          // a retired UUID nor point ticket ingestion at a non-existent row.
          const suppliedMap = parsed.data.departmentOptionIds;
          if (suppliedMap !== undefined) {
            const values = Object.values(suppliedMap as Record<string, unknown>);
            if (values.some((value) => typeof value !== "string" || !value.trim())) {
              return { error: "Each Department option mapping must reference a department UUID" };
            }
            const departmentIds = [...new Set(values as string[])];
            const lockedDepartments = departmentIds.length > 0
              ? await tx
                  .select({ id: sdDepartments.id })
                  .from(sdDepartments)
                  .where(inArray(sdDepartments.id, departmentIds))
                  .for("update")
              : [];
            if (lockedDepartments.length !== departmentIds.length) {
              return { error: "A Department option mapping references a department that no longer exists. Refresh and review the mapping." };
            }
          }

          const [saved] = existing
            ? await tx
                .update(sdListMapping)
                .set({ ...parsed.data, updatedAt: new Date() })
                .where(eq(sdListMapping.id, existing.id))
                .returning()
            : await tx.insert(sdListMapping).values({ ...parsed.data }).returning();
          return { config: saved };
        });
      });
      if ("error" in saveResult) {
        return res.status(400).json({ error: saveResult.error });
      }
      const updated = saveResult.config;

      // Save-time validation (Task #3176): if any waiting-on field UUID is bound
      // and we can reach ClickUp, verify each bound UUID exists on the List.
      // Warnings never block the save — they surface in the wizard UI.
      let fieldWarnings: Array<{ key: string; label: string; id: string; message: string }> = [];
      try {
        const hasBoundWaiting = WAITING_FIELD_BINDINGS.some(
          (b) => typeof (updated as any)?.[b.key] === "string" && (updated as any)[b.key],
        );
        if (updated?.clickupListId && hasBoundWaiting) {
          const token = await getCeoToken(req);
          if (token) {
            const { fields: mergedFields, levelErrors: saveLevelErrors } = await getMergedCustomFields(
              token,
              updated as any,
            );
            fieldWarnings = findStaleWaitingFieldBindings(updated as any, mergedFields).map((s) => ({
              ...s,
              message:
                saveLevelErrors.length > 0
                  ? `${s.label} UUID ${s.id} was not found in the levels that could be checked (some levels failed: ${saveLevelErrors.join(", ")}) — re-copy the field ID from ClickUp.`
                  : `${s.label} UUID ${s.id} was not found on the ClickUp List at any level — re-copy the field ID from ClickUp.`,
            }));
          }
        }
      } catch (verifyErr: any) {
        console.warn("[ServiceDesk] config save-time field verification skipped:", verifyErr?.message);
      }

      res.json({ config: updated, fieldWarnings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Setup: create Space/Folder/List in ClickUp ──────────────────────────────
  // Idempotent: checks if the named hierarchy already exists before creating.
  // API note: custom statuses on the List must be configured manually in ClickUp
  // (no create-field API). The 15 custom statuses and field definitions are
  // listed in the checklist endpoint below.

  app.post(
    "/api/service-desk/setup/create-structure",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        if (!token) {
          return res.status(403).json({
            error: "ClickUp not connected. You must connect your own ClickUp account — go to your Profile page (/profile) to connect.",
            requiresClickUpConnection: true,
          });
        }

        const { workspaceId } = req.body as { workspaceId?: string };
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

        const config = await getListMappingConfig();
        const spaceName = "NoBull OS Service Desk";
        const folderName = "Internal Requests";
        const listName = "All Service Requests";

        // Step 1: Space — find existing or create
        const spaces = await cu.getSpaces(token, workspaceId);
        let space = spaces.find((s: any) => s.name === spaceName);
        if (!space) {
          space = await cu.createSpace(token, workspaceId, { name: spaceName });
        }
        const spaceId = String(space.id);

        // Step 2: Folder — find existing or create
        const folders = await cu.getFolders(token, spaceId);
        let folder = folders.find((f: any) => f.name === folderName);
        if (!folder) {
          folder = await cu.createFolder(token, spaceId, folderName);
        }
        const folderId = String(folder.id);

        // Step 3: List — find existing or create
        const lists = await cu.getListsInFolder(token, folderId);
        let list = lists.find((l: any) => l.name === listName);
        if (!list) {
          list = await cu.createListInFolder(token, folderId, { name: listName });
        }
        const listId = String(list.id);

        // Persist to config
        await withDbAttribution("serviceDesk:persistStructure", async () => {
          const db = getDb();
          if (config) {
            await db
              .update(sdListMapping)
              .set({
                clickupSpaceId: spaceId,
                clickupFolderId: folderId,
                clickupListId: listId,
                clickupWorkspaceId: workspaceId,
                setupStep: "list_created",
                updatedAt: new Date(),
              })
              .where(eq(sdListMapping.id, config.id));
          } else {
            await db.insert(sdListMapping).values({
              clickupSpaceId: spaceId,
              clickupFolderId: folderId,
              clickupListId: listId,
              clickupWorkspaceId: workspaceId,
              setupStep: "list_created",
            });
          }
        });

        res.json({
          success: true,
          spaceId,
          folderId,
          listId,
          spaceName,
          folderName,
          listName,
        });
      } catch (err: any) {
        console.error("[ServiceDesk] create-structure error:", err?.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Setup: auto-fill custom field UUIDs from ClickUp ───────────────────────
  // Fetches the bound List's custom fields (GET /v2/list/{listId}/field) and
  // matches them to the 10 required bindings by field NAME (case-insensitive).
  // Only matched bindings are written; unmatched ones are reported back so the
  // admin can fix the field name in ClickUp or paste the UUID manually.

  app.post(
    "/api/service-desk/setup/autofill-fields",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const token = await getCeoToken(req);
        if (!token) {
          return res.status(403).json({
            error: "ClickUp not connected. Go to your Profile page (/profile) to connect.",
            requiresClickUpConnection: true,
          });
        }
        const config = await getListMappingConfig();
        if (!config?.clickupListId) {
          return res.status(400).json({
            error: 'No List bound yet — run "Create ClickUp Structure" on the Setup tab first.',
          });
        }

        const { fields } = await getMergedCustomFields(token, config);
        const byName = new Map<string, string>();
        for (const f of fields) {
          const name = String(f?.name ?? "").trim().toLowerCase();
          if (name && f?.id && !byName.has(name)) byName.set(name, String(f.id));
        }

        // Accepted name variants per binding (all lowercase).
        const BINDINGS: Array<{ key: string; label: string; names: string[] }> = [
          { key: "fieldClientId", label: "Client", names: ["client"] },
          { key: "fieldDepartmentId", label: "Department", names: ["department"] },
          { key: "fieldOwnerDeptId", label: "Owner Department", names: ["owner department", "owner dept"] },
          { key: "fieldRequestTypeId", label: "Request Type", names: ["request type"] },
          { key: "fieldRequesterId", label: "Requester", names: ["requester"] },
          {
            key: "fieldRequestedDateId",
            label: "Requested Completion Date",
            names: ["requested completion date", "requested date"],
          },
          {
            key: "fieldCommittedDateId",
            label: "Committed Completion Date",
            names: ["committed completion date", "committed date"],
          },
          { key: "fieldWaitingWhoId", label: "Waiting On", names: ["waiting on", "waiting on (who)"] },
          { key: "fieldWaitingWhatId", label: "Action Needed", names: ["action needed", "action needed (what)"] },
          {
            key: "fieldWaitingWhenId",
            label: "Response Needed By",
            names: ["response needed by", "response needed by (when)"],
          },
        ];

        const updates: Record<string, string> = {};
        const matched: Array<{ key: string; label: string; fieldId: string }> = [];
        const missing: string[] = [];
        for (const b of BINDINGS) {
          const hit = b.names.map((n) => byName.get(n)).find((id) => id);
          if (hit) {
            updates[b.key] = hit;
            matched.push({ key: b.key, label: b.label, fieldId: hit });
          } else {
            missing.push(b.label);
          }
        }

        if (matched.length > 0) {
          await withDbAttribution("serviceDesk:autofillFields", async () => {
            const db = getDb();
            await db
              .update(sdListMapping)
              .set({ ...updates, updatedAt: new Date() })
              .where(eq(sdListMapping.id, config.id));
          });
        }

        console.log(
          `[ServiceDesk] autofill-fields: matched=${matched.length} missing=${missing.length}${
            missing.length ? ` (${missing.join(", ")})` : ""
          }`,
        );
        res.json({ success: true, matched, missing, totalListFields: fields.length });
      } catch (err: any) {
        console.error("[ServiceDesk] autofill-fields error:", err?.message);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Setup: verify checklist ─────────────────────────────────────────────────
  // Returns the status of each manual and auto-checkable setup step.
  // Custom statuses and field definitions cannot be created via API, so they
  // appear as "manual" items with instructions.

  app.get("/api/service-desk/setup/verify", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const token = await getCeoToken(req);
      const config = await getListMappingConfig();

      const checks: Array<{
        key: string;
        label: string;
        status: "ok" | "missing" | "unchecked" | "manual";
        detail?: string;
      }> = [];

      // Check 1: Structure created
      checks.push({
        key: "structure",
        label: "ClickUp Space / Folder / List created",
        status: config?.clickupListId ? "ok" : "missing",
        detail: config?.clickupListId
          ? `List ID: ${config.clickupListId}`
          : 'Run "Create ClickUp Structure" to create the Space → Folder → List.',
      });

      // Check 2: Verify the list still exists (only if token available and list configured)
      if (config?.clickupListId && token) {
        try {
          const list = await cu.getList(token, config.clickupListId);
          // Fetch from all hierarchy levels so inherited fields (created above List)
          // are visible in the custom-fields check. getMergedCustomFields tolerates
          // individual level-endpoint failures and reports them in levelErrors.
          let fields: any[] = [];
          let verifyLevelErrors: string[] = [];
          let fieldsResult: any[] | null = null;
          try {
            const merged = await getMergedCustomFields(token, config);
            fields = merged.fields;
            verifyLevelErrors = merged.levelErrors;
            fieldsResult = fields;
          } catch {
            fieldsResult = null;
          }
          const statusCount = Array.isArray(list?.statuses) ? list.statuses.length : 0;

          checks.push({
            key: "list_exists",
            label: "List accessible in ClickUp",
            status: "ok",
            detail: `"${list.name}" — ${statusCount} statuses, ${fields.length} custom field(s) found${verifyLevelErrors.length ? ` (${verifyLevelErrors.length} level(s) could not be checked)` : ""}`,
          });

          // Check custom statuses — compare names against the canonical 15-status set
          const REQUIRED_STATUSES = [
            "Submitted", "Scheduled", "In Progress", "Needs Information",
            "Waiting on Account Manager", "Waiting on Client", "Waiting on Approval",
            "Blocked", "Quality Review", "Delivered", "Closed", "Reopened",
            "Out of Scope", "Canceled", "Duplicate",
          ];
          const listStatusNames: string[] = Array.isArray(list?.statuses)
            ? (list.statuses as any[]).map((s: any) => (s.status ?? s.name ?? "").toLowerCase())
            : [];
          const missingStatuses = REQUIRED_STATUSES.filter(
            (s) => !listStatusNames.includes(s.toLowerCase()),
          );
          checks.push({
            key: "statuses",
            label: "15 required statuses configured on the List",
            status: missingStatuses.length === 0 ? "ok" : "manual",
            detail:
              missingStatuses.length === 0
                ? `All ${REQUIRED_STATUSES.length} required statuses present`
                : `Missing ${missingStatuses.length} status(es) — add in ClickUp: ${missingStatuses.join(", ")}`,
          });

          // Check custom fields
          const requiredFieldNames = [
            "Client",
            "Department",
            "Owner Department",
            "Request Type",
            "Requester",
            "Requested Completion Date",
            "Committed Completion Date",
            "Waiting On",
            "Action Needed",
            "Response Needed By",
          ];
          const fieldNames = fields.map((f: any) => f.name);
          const missingFields = requiredFieldNames.filter(
            (n) => !fieldNames.some((fn: string) => fn.toLowerCase() === n.toLowerCase()),
          );
          checks.push({
            key: "custom_fields",
            label: "Custom fields defined on the List",
            status: missingFields.length === 0 ? "ok" : "manual",
            detail:
              missingFields.length === 0
                ? `All ${requiredFieldNames.length} required fields found`
                : `Missing fields — add in ClickUp: ${missingFields.join(", ")}`,
          });

          // Check field UUIDs bound — all 10 required fields must have a UUID configured
          const requiredFieldKeys: Array<keyof typeof config> = [
            "fieldClientId", "fieldDepartmentId", "fieldOwnerDeptId",
            "fieldRequestTypeId", "fieldRequesterId", "fieldRequestedDateId",
            "fieldCommittedDateId", "fieldWaitingWhoId", "fieldWaitingWhatId",
            "fieldWaitingWhenId",
          ];
          const missingFieldKeys = requiredFieldKeys.filter((k) => !config[k]);
          checks.push({
            key: "field_mapping",
            label: "All 10 custom field UUIDs bound in NoBull config",
            status: missingFieldKeys.length === 0 ? "ok" : "missing",
            detail:
              missingFieldKeys.length === 0
                ? "All 10 field UUID bindings configured"
                : `Missing ${missingFieldKeys.length} binding(s): ${missingFieldKeys.join(", ")} — use the Field Mapping tab.`,
          });

          // Check that bound waiting-on field UUIDs actually exist on the ClickUp
          // list (Task #3176) — a stale/mistyped UUID silently drops metadata on
          // the first transition, so catch it here at setup time.
          if (fieldsResult === null) {
            checks.push({
              key: "waiting_field_uuids",
              label: "Waiting-on field UUIDs exist on the ClickUp List",
              status: "unchecked",
              detail: "Could not fetch the List's custom fields from ClickUp — re-run verification.",
            });
          } else {
            const staleWaiting = findStaleWaitingFieldBindings(config as any, fields);
            const boundWaiting = WAITING_FIELD_BINDINGS.filter((b) => (config as any)[b.key]);
            const partialNote = verifyLevelErrors.length > 0
              ? ` (some levels could not be checked: ${verifyLevelErrors.join(", ")})`
              : "";
            checks.push({
              key: "waiting_field_uuids",
              label: "Waiting-on field UUIDs exist on the ClickUp List",
              status: staleWaiting.length === 0 ? (verifyLevelErrors.length > 0 ? "unchecked" : "ok") : "missing",
              detail:
                staleWaiting.length === 0
                  ? verifyLevelErrors.length > 0
                    ? `Check incomplete${partialNote} — re-run verification once all levels are reachable.`
                    : boundWaiting.length === WAITING_FIELD_BINDINGS.length
                      ? "All 3 waiting-on field UUIDs match fields on the List"
                      : `${boundWaiting.length}/3 waiting-on UUIDs bound; all bound ones match the List`
                  : `UUID(s) not found at any level checked${partialNote}: ${staleWaiting
                      .map((s) => `${s.label} (${s.id})`)
                      .join(", ")} — re-copy the field IDs from ClickUp into the Config tab.`,
            });
          }

          // Check option-ID maps for Department and Request Type dropdown fields
          const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
          const rtOptMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;
          const deptMapped = Object.keys(deptOptMap).length;
          const rtMapped = Object.keys(rtOptMap).length;
          checks.push({
            key: "option_maps",
            label: "Department and Request Type dropdown options mapped",
            status: deptMapped > 0 && rtMapped > 0 ? "ok" : "missing",
            detail:
              deptMapped > 0 && rtMapped > 0
                ? `${deptMapped} dept option(s), ${rtMapped} request type option(s) mapped`
                : `Use the Option Maps tab — Dept: ${deptMapped} mapped, RT: ${rtMapped} mapped. Ticket routing requires both.`,
          });

          // Check Client dropdown option map
          const clientOptMap = (config.clientOptionIds ?? {}) as Record<string, string>;
          const clientMapped = Object.keys(clientOptMap).length;
          if (config.fieldClientId) {
            checks.push({
              key: "client_option_map",
              label: "Client dropdown options synced and mapped",
              status: clientMapped > 0 ? "ok" : "manual",
              detail:
                clientMapped > 0
                  ? `${clientMapped} client option(s) mapped — use Field Mapping → Client Options to review gaps.`
                  : "Client field is configured. If it is a Dropdown in ClickUp, press \"Sync client options\" in the Field Mapping tab to build the option map. Text fields can skip this step.",
            });
          }
        } catch {
          checks.push({
            key: "list_exists",
            label: "List accessible in ClickUp",
            status: "missing",
            detail: "Could not fetch list — check ClickUp connection and list ID.",
          });
        }
      } else {
        checks.push({
          key: "list_exists",
          label: "List accessible in ClickUp",
          status: config?.clickupListId ? "unchecked" : "missing",
          detail: config?.clickupListId
            ? "Connect your ClickUp account to verify."
            : "Structure not yet created.",
        });
      }

      // Manual items (cannot be API-verified)
      checks.push({
        key: "master_form",
        label: "Master ClickUp Form created and linked",
        status: config?.masterFormUrl ? "ok" : "manual",
        detail: config?.masterFormUrl
          ? `Form URL: ${config.masterFormUrl}`
          : "Create the Form inside the List in ClickUp, then paste the URL in config. Enable hidden fields: Email, Client (Text), Department (Dropdown), Priority (Priority).",
      });

      res.json({ checks });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
