import type { Express } from "express";
  import { storage } from "../storage";
  import { db } from "../db";
  import { sql } from "drizzle-orm";
  import { isAuthenticated } from "../middlewares/requireAuth";
  import { hasRole, requireAccountManager } from "./middleware";
  import type { AuthenticatedRequest } from "./requestContext";
  import { clientListCsvHandler } from "./clientsCsv";
  import { onLocationChanged } from "../mcu/worker";
  import { insertClientSchema } from "@shared/schema";
  // Task #3711 — client offboarding (auto-archive on final service day).
  import {
    cancelScheduledOffboarding,
    getActiveOffboardingForClient,
    getActiveOffboardingsByClientIds,
    OffboardingExecutingError,
    scheduleClientOffboarding,
  } from "../storage/clientOffboardingStorage";
  import { applyClientArchivalSideEffects } from "../services/clientArchive";
  import { todayInNewYork } from "../services/clientOffboardingSweep";
  import { toAccountRatingPresentation } from "../services/judgmentTierGate";

  /**
   * Task #3711 — attach each client's scheduled offboarding (if any) to a
   * list payload as `offboarding: { id, finalServiceDate, status } | null`
   * so the Client Management list can badge "Offboarding — final day …".
   * Degrades to the bare list on error (loudly) rather than 500ing the
   * app's core client list over a decorative badge.
   */
  async function attachOffboardings<T extends { id: string }>(clientList: T[]): Promise<(T & {
    offboarding: { id: string; finalServiceDate: string; status: string } | null;
  })[]> {
    if (clientList.length === 0) return clientList.map((c) => ({ ...c, offboarding: null }));
    try {
      const map = await getActiveOffboardingsByClientIds(clientList.map((c) => c.id));
      return clientList.map((c) => {
        const ob = map.get(c.id);
        return {
          ...c,
          offboarding: ob ? { id: ob.id, finalServiceDate: ob.finalServiceDate, status: ob.status } : null,
        };
      });
    } catch (e: any) {
      console.error("[Clients] offboarding enrichment failed (list served without badges):", e?.message);
      return clientList.map((c) => ({ ...c, offboarding: null }));
    }
  }
  
  export function registerClientRoutes(app: Express) {
    // CLIENTS API
  // ============================================
  
  // Get clients - filtered by role, supports pagination
  // Query params: showArchived=true to include archived clients
  app.get("/api/clients", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Parse pagination params (optional)
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 0; // 0 = no pagination
      const offset = limit > 0 ? (page - 1) * limit : 0;
      const showArchived = req.query.showArchived === 'true';
      
      const isCeo = user?.role === 'ceo';
      
      // Filter function to apply archive and demo filters
      const applyFilters = (clients: any[], filterDemo: boolean) => {
        return clients.filter((c: any) => {
          if (filterDemo && c.isDemo) return false;
          if (!showArchived && c.isArchived) return false;
          return true;
        });
      };
      
      // CEO sees all clients including demo clients
      if (isCeo) {
        if (limit > 0) {
          const result = await storage.getClientsPaginated(limit, offset);
          const filtered = applyFilters(result.data, false);
          return res.json({ data: await attachOffboardings(filtered), total: filtered.length, page, limit });
        }
        const clients = await storage.getClients();
        const filtered = applyFilters(clients, false);
        return res.json(await attachOffboardings(filtered));
      }
      
      // Team Lead and Account Manager see all clients except demo clients
      if (hasRole(user?.role, 'account_manager')) {
        if (limit > 0) {
          const result = await storage.getClientsPaginated(limit, offset);
          const filtered = applyFilters(result.data, true);
          return res.json({ data: await attachOffboardings(filtered), total: filtered.length, page, limit });
        }
        const clients = await storage.getClients();
        const filtered = applyFilters(clients, true);
        return res.json(await attachOffboardings(filtered));
      }

      // Other roles (e.g., sales) see only their own clients
      if (limit > 0) {
        const result = await storage.getClientsByOwnerPaginated(userId, limit, offset);
        const filtered = applyFilters(result.data, true);
        return res.json({ data: await attachOffboardings(filtered), total: filtered.length, page, limit });
      }
      const clients = await storage.getClientsByOwner(userId);
      const filtered = applyFilters(clients, true);
      res.json(await attachOffboardings(filtered));
    } catch (error) {
      console.error("Error fetching clients:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #4990 — full client-list CSV export (every clients-table column,
  // archived rows always included and identifiable via isArchived). Role
  // scoping mirrors GET /api/clients above exactly; handler lives in
  // ./clientsCsv. Registered here, BEFORE GET /api/clients/:id below, so the
  // ":id" matcher can never swallow "export.csv". Multi-line registration on
  // purpose: the route-inventory parser resolves bare-reference handlers via
  // its stitched multi-line pass (tests/route-inventory.ts BARE_REF_CLOSE_REGEX).
  app.get(
    "/api/clients/export.csv",
    isAuthenticated,
    clientListCsvHandler,
  );

  app.get("/api/dashboard/client-summaries", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const isCeo = user.role === "ceo";
      const isTeamLeadPlus = hasRole(user.role, "team_lead");

      let clientList: any[];
      if (isCeo) {
        clientList = await storage.getClients();
      } else if (hasRole(user?.role, 'account_manager')) {
        clientList = (await storage.getClients()).filter((c: any) => !c.isDemo);
      } else {
        clientList = (await storage.getClientsByOwner(userId)).filter((c: any) => !c.isDemo);
      }
      clientList = clientList.filter((c: any) => !c.isArchived);

      if (clientList.length === 0) return res.json([]);

      const clientIds = clientList.map((c: any) => c.id);
      const idList = sql.join(clientIds.map((id: string) => sql`${id}`), sql`, `);

      const ownerIds = [...new Set(clientList.map((c: any) => c.ownerId).filter(Boolean))];

      const [commsResult, judgmentsResult, panelsResult, ownersResult] = await Promise.all([
        // Task #2675 — bound the comms aggregation hold. This per-client
        // COUNT/MAX rollup over `raw_communication_records` (a continuously
        // growing, Front-fed table) is the heaviest read on this request-scoped
        // `api`-pool endpoint. Production EXPLAIN ANALYZE shows it normally runs
        // as an index-only scan on `raw_comm_client_touchpoint_idx` in ~110ms
        // even for a CEO loading all clients, so the indexing is already
        // optimal. The reported failure ("Network error" + zeros) is not a
        // missing index — it's the connection being cut while this query stalls
        // for many seconds under worker-pool contention (Front recovery
        // backfills saturating the shared Neon primary), which also pins an
        // `api` connection for the whole stall. A 9s LOCAL statement_timeout
        // (≈80x the normal runtime, and under the 10s DB-hold warn threshold)
        // converts that pathological stall into a fast, clean 57014 error so
        // the request releases its pool connection promptly and the client's
        // self-healing retry (see Dashboard `DASHBOARD_QUERY_OPTIONS`) can
        // recover on a later attempt instead of the user staring at a hung
        // load. It never fires under normal conditions. Wrapped in a
        // transaction so `SET LOCAL` cannot leak onto a pooled connection.
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '9000ms'`);
          return tx.execute(sql`
            SELECT client_id,
              MAX(timestamp) as last_comm_date,
              COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '30 days')::int as comm_count_30d,
              COUNT(*)::int as comm_count_total,
              COUNT(*) FILTER (WHERE is_touchpoint = true AND timestamp >= NOW() - INTERVAL '30 days')::int as touchpoint_count_30d,
              COUNT(*) FILTER (WHERE is_touchpoint = true)::int as touchpoint_count_total,
              MAX(timestamp) FILTER (WHERE is_touchpoint = true) as last_touchpoint_date
            FROM raw_communication_records
            WHERE client_id IN (${idList})
            GROUP BY client_id
          `);
        }),
        db.execute(sql`
          SELECT DISTINCT ON (client_id) client_id, status,
            COALESCE(relationship_health, relationship_status) AS relationship_health,
            judgment_date, headline,
            confidence_level, confidence, risk_score, data_sources_summary
          FROM client_daily_judgments
          WHERE client_id IN (${idList})
          ORDER BY client_id, judgment_date DESC, created_at DESC
        `),
        db.execute(sql`
          SELECT client_id, last_reviewed_at, budget_posture, google_ads_budget, lsa_budget, webinar_budget
          FROM command_panels
          WHERE client_id IN (${idList})
        `),
        ownerIds.length > 0
          ? db.execute(sql`
              SELECT id, first_name, last_name, email, profile_image_url FROM users
              WHERE id IN (${sql.join(ownerIds.map((id: string) => sql`${id}`), sql`, `)})
            `)
          : Promise.resolve({ rows: [] }),
      ]);

      const commsMap: Record<string, { lastCommDate: string | null; commCount30d: number; commCountTotal: number; touchpointCount30d: number; touchpointCountTotal: number; lastTouchpointDate: string | null }> = {};
      for (const row of commsResult.rows as any[]) {
        commsMap[row.client_id] = {
          lastCommDate: row.last_comm_date,
          commCount30d: row.comm_count_30d,
          commCountTotal: row.comm_count_total,
          touchpointCount30d: row.touchpoint_count_30d,
          touchpointCountTotal: row.touchpoint_count_total,
          lastTouchpointDate: row.last_touchpoint_date,
        };
      }

      // Task #3697 — surface the judgment's data basis (what it was based on,
      // what was missing, carried-forward marker) plus confidence so the
      // Dashboard health column can show honest limited-data indicators.
      // Older rows have arbitrary/absent dataSourcesSummary shapes, so this
      // reads defensively and returns null instead of a partial object.
      const slimJudgmentBasis = (raw: any): { tier: string | null; basedOn: string[]; missing: string[]; carriedForward: { fromDate: string | null } | null } | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const basedOn = Array.isArray(raw.basedOn) ? raw.basedOn.filter((v: any) => typeof v === "string") : [];
        const missing = Array.isArray(raw.missing) ? raw.missing.filter((v: any) => typeof v === "string") : [];
        const tier = typeof raw.tier === "string" ? raw.tier : null;
        if (!tier && basedOn.length === 0 && missing.length === 0) return null;
        return {
          tier,
          basedOn,
          missing,
          carriedForward: raw.carriedForward
            ? { fromDate: typeof raw.carriedForward.fromDate === "string" ? raw.carriedForward.fromDate : null }
            : null,
        };
      };

      const judgmentMap: Record<string, {
        status: string;
        relationshipHealth: string;
        judgmentDate: string;
        headline: string | null;
        confidence: string | null;
        basis: ReturnType<typeof slimJudgmentBasis>;
        rating: ReturnType<typeof toAccountRatingPresentation>;
      }> = {};
      for (const row of judgmentsResult.rows as any[]) {
        judgmentMap[row.client_id] = {
          status: row.status,
          relationshipHealth: row.relationship_health,
          judgmentDate: row.judgment_date,
          headline: row.headline,
          confidence: row.confidence_level || row.confidence || null,
          basis: slimJudgmentBasis(row.data_sources_summary),
          rating: toAccountRatingPresentation({
            status: row.status,
            relationship: row.relationship_health,
            riskScore: row.risk_score,
            judgmentDate: row.judgment_date,
            dataSourcesSummary: row.data_sources_summary,
          }),
        };
      }

      const panelMap: Record<string, { lastReviewedAt: string | null; budgetPosture: string | null; googleAdsBudget: number | null; lsaBudget: number | null; webinarBudget: number | null }> = {};
      for (const row of panelsResult.rows as any[]) {
        panelMap[row.client_id] = {
          lastReviewedAt: row.last_reviewed_at,
          budgetPosture: row.budget_posture,
          googleAdsBudget: row.google_ads_budget,
          lsaBudget: row.lsa_budget,
          webinarBudget: row.webinar_budget,
        };
      }

      const ownerMap: Record<string, { name: string; avatar: string | null }> = {};
      for (const row of ownersResult.rows as any[]) {
        ownerMap[row.id] = {
          name: row.first_name
            ? `${row.first_name}${row.last_name ? " " + row.last_name : ""}`
            : row.email || "Unknown",
          avatar: row.profile_image_url || null,
        };
      }

      const summaries = clientList.map((c: any) => {
        const comms = commsMap[c.id];
        const judgment = judgmentMap[c.id];
        const panel = panelMap[c.id];
        return {
          id: c.id,
          firmName: c.firmName,
          clientCode: c.clientCode,
          contactName: c.contactName,
          // Task #4363 — same marker as the "Demo Account" badge, so the
          // global hide-demo toggle can filter client-side (CEO is the only
          // role that still sees demo rows here).
          isDemo: !!c.isDemo,
          products: c.products || [],
          practiceAreas: c.practiceAreas || [],
          clientStartDate: c.clientStartDate,
          ownerId: c.ownerId,
          ownerName: c.ownerId ? ownerMap[c.ownerId]?.name || null : null,
          ownerAvatar: c.ownerId ? ownerMap[c.ownerId]?.avatar || null : null,
          lastCommDate: comms?.lastCommDate || null,
          commCount30d: comms?.commCount30d || 0,
          commCountTotal: comms?.commCountTotal || 0,
          touchpointCount30d: comms?.touchpointCount30d || 0,
          touchpointCountTotal: comms?.touchpointCountTotal || 0,
          lastTouchpointDate: comms?.lastTouchpointDate || null,
          judgmentStatus: judgment?.status || null,
          relationshipHealth: judgment?.relationshipHealth || null,
          judgmentHeadline: judgment?.headline || null,
          judgmentDate: judgment?.judgmentDate || null,
          judgmentConfidence: judgment?.confidence || null,
          judgmentBasis: judgment?.basis || null,
          accountRating: judgment?.rating || null,
          lastReviewedAt: panel?.lastReviewedAt || null,
          budgetPosture: panel?.budgetPosture || null,
          hideOtherLeads: c.hideOtherLeads || false,
          terminology: c.terminology || null,
        };
      });

      res.json(summaries);
    } catch (error) {
      console.error("[Dashboard] Error fetching client summaries:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:id", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const isCeo = user?.role === 'ceo';
      
      // Demo clients only visible to CEO
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Task #1796: operator opening the client dashboard counts as
      // activity for the demand-driven SEMrush gate. Best-effort.
      try {
        const { markClientViewed } = await import(
          "../services/semrushCadenceGate"
        );
        void markClientViewed(client.id, "client:dashboard_load");
      } catch {}

      res.json(client);
    } catch (error) {
      console.error("Error fetching client:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:id/summary", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      const isCeo = user?.role === 'ceo';
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (!hasRole(user?.role, 'team_lead') && user?.role !== 'account_manager' && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const [reports, dataAccess, contacts, offboarding] = await Promise.all([
        storage.getReportsByClient(req.params.id),
        storage.getClientDataAccess(req.params.id),
        storage.getClientContacts(req.params.id),
        // Task #3711 — active offboarding (if any) for the detail-page badge.
        getActiveOffboardingForClient(req.params.id),
      ]);

      res.json({ client, reports, dataAccess, contacts, offboarding: offboarding ?? null });
    } catch (error) {
      console.error("Error fetching client summary:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Get reports for a specific client
  app.get("/api/clients/:id/reports", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // CEO and Team Lead can view any client's reports
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const reports = await storage.getReportsByClient(req.params.id);
      res.json(reports);
    } catch (error) {
      console.error("Error fetching client reports:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Create client - Account Manager can create (self-assigns), Team Lead+ can create for anyone
  app.post("/api/clients", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Extract locations + team assignments from body before parsing client
      // data (neither belongs to insertClientSchema).
      const { locations, teamAssignments, ...clientBody } = req.body;
      
      let bodyData = clientBody;
      if (!hasRole(user?.role, 'account_manager')) {
        const { ownerId, ...rest } = bodyData;
        bodyData = { ...rest, ownerId: userId };
      }
      
      // Convert date strings to Date objects
      if (bodyData.clientStartDate && typeof bodyData.clientStartDate === 'string') {
        bodyData.clientStartDate = new Date(bodyData.clientStartDate);
      }
      
      const parsed = insertClientSchema.safeParse(bodyData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }

      const clientData = parsed.data;
      const { validateProductList, CANONICAL_PRODUCTS } = await import("../utils/productResolution");
      const productsInput = Array.isArray(clientData.products) ? clientData.products : [];
      const { normalized: normalizedProducts, invalid: invalidProducts } = validateProductList(productsInput);
      if (invalidProducts.length > 0) {
        return res.status(400).json({
          error: "Unknown product value(s) submitted. Allowed products: " + CANONICAL_PRODUCTS.join(", ") + ".",
          code: "INVALID_PRODUCTS",
          invalid: invalidProducts,
          allowed: [...CANONICAL_PRODUCTS],
        });
      }
      if (normalizedProducts.length === 0) {
        return res.status(400).json({ error: "At least one product is required to create a client." });
      }
      clientData.products = normalizedProducts;

      // Task #4790 — vendor/receipt identifiers are never client identifiers.
      // Screen trusted domains + the legacy primary contact email here so this
      // authoritative writer can't (re-)poison client identity data the way
      // the Dellutri vendor-domain incident did.
      {
        const { findVendorIdentifierViolations, vendorIdentifierRefusalMessage } = await import(
          "../services/seedingTrustPolicy"
        );
        const violations = findVendorIdentifierViolations({
          emailDomains: clientData.emailDomains,
          emails: clientData.contactEmail ? [clientData.contactEmail] : undefined,
        });
        if (violations.length > 0) {
          return res.status(400).json({
            error: vendorIdentifierRefusalMessage(violations),
            code: "VENDOR_IDENTIFIER_REFUSED",
            violations,
          });
        }
      }

      // Task #4171 — validate the Add Client form's per-department role
      // selections and build the seed plan BEFORE creating the client, so a
      // bad selection (unknown department, non-member pick) rejects the whole
      // request without a half-created client. Untouched roles inherit the
      // department defaults; client-facing departments are seeded even when
      // no selections were sent at all.
      const { prepareClientTeamSeed, applyClientTeamSeed } = await import("./serviceDesk/helpers");
      const teamSeed = await prepareClientTeamSeed(teamAssignments);
      if (!teamSeed.ok) {
        return res.status(teamSeed.status).json({ error: teamSeed.error });
      }

      const client = await storage.createClient(clientData);

      // Task #4329 — rule tags + segment membership evaluate on write
      // (never fails the write; the periodic sweep heals any miss).
      const { evaluateRecordWriteSafe } = await import("../services/tagSegmentEngine");
      await evaluateRecordWriteSafe("client", client.id);

      // Task #4762 — a client created WITH trusted email domains drains its
      // own backlog: kick the scoped deterministic re-match so pre-existing
      // unmatched Front traffic on those domains attaches without an operator
      // press (the 6h-enrolled full re-match is the backstop). Non-fatal.
      const createdEmailDomains = (client as any)?.emailDomains;
      if (Array.isArray(createdEmailDomains) && createdEmailDomains.length > 0) {
        try {
          const { enqueueRetroactiveReprocessSafe, periodicDedupeKey } = await import(
            "../services/retroactiveReprocessControl"
          );
          await enqueueRetroactiveReprocessSafe({
            clientId: client.id,
            source: "client_domain_edit",
            workloadClass: "interactive_repair",
            dedupeKey: periodicDedupeKey(client.id),
          });
        } catch (err: any) {
          console.warn(
            "[CreateClient] domain re-match enqueue failed (non-fatal):",
            err?.message ?? err,
          );
        }
      }

      // Seed the client's department role assignments (Task #4171). The
      // client already exists — a seeding failure must never fail or retry
      // the whole request (a duplicate client would be worse), so it degrades
      // to a loud log + warning in the response; operators can fill the rows
      // in Client Detail or the Role Assignments console.
      let teamAssignmentsSeeded = 0;
      let teamAssignmentWarning: string | null = null;
      try {
        teamAssignmentsSeeded = await applyClientTeamSeed(client.id, teamSeed.seed);
      } catch (seedErr: any) {
        console.error("[CreateClient] Team assignment seeding failed:", seedErr?.message ?? seedErr);
        teamAssignmentWarning =
          "The client was created, but its team role assignments could not be saved. Set them from the client's page or the Role Assignments console.";
      }

      // Provision a private comms channel for the new client (fire-and-forget —
      // a channel failure must never block client creation; errors logged inside).
      void (async () => {
        try {
          const { provisionClientChannel } = await import("../storage/commsStorage");
          const slug = (client.firmName ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40);
          await provisionClientChannel(client.id, `client-${slug || client.id.slice(0, 8)}`);
        } catch (e: any) {
          console.warn("[Clients] Comms channel provision skipped:", e?.message);
        }
      })();

      // Each draft location must carry a name and a full street address. The
      // address is geocoded (street + city + state + ZIP) for MCU capacity
      // analysis — name-only geocoding silently produced wrong/unfindable
      // coordinates (Task #2487). Per-location failures are surfaced back to the
      // operator rather than silently persisting a coordinate-less location.
      let locationsCreated = false;
      const locationWarnings: { name: string; reason: string }[] = [];
      if (locations && Array.isArray(locations)) {
        const { geocodeLocationText } = await import("../mcu/geocoding");
        for (const entry of locations) {
          const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
          const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
          if (!name) {
            // A non-UI caller could post a malformed/empty entry. Surface it as a
            // warning instead of silently dropping it so the response is honest
            // about what was (and wasn't) created.
            if (address) {
              locationWarnings.push({
                name: address,
                reason: "A location name is required. Add this location again with both a name and a full street address.",
              });
            }
            continue;
          }
          if (address.length < 10) {
            locationWarnings.push({
              name,
              reason: "A full street address is required — include street, city, state, and ZIP (e.g. 123 Main St, Dallas, TX 75201).",
            });
            continue;
          }
          try {
            const geocoded = await geocodeLocationText(name, address);
            if (geocoded.lat == null || geocoded.lng == null) {
              // Distinguish an unfindable address (operator fixes it) from a
              // quota/key/provider fault (system issue, not their input).
              const reason = geocoded.geocodeFailureReason === "system"
                ? "Address validation is temporarily unavailable due to a system issue (not your address). Add this location again from the client's page in a few minutes."
                : "We couldn't find that address. Add this location again with a complete, valid US street address (street, city, state, and ZIP).";
              locationWarnings.push({ name, reason });
              console.warn(`[CreateClient] Location "${name}" geocode failed: ${geocoded.geocodeFailureReason ?? "not_found"}`);
              continue;
            }
            await storage.createClientLocation({
              clientId: client.id,
              name: geocoded.name,
              address: geocoded.address,
              city: geocoded.city,
              state: geocoded.state,
              lat: geocoded.lat,
              lng: geocoded.lng,
              stateFips: geocoded.stateFips,
              countyFips: geocoded.countyFips,
              geocodedAt: geocoded.geocodedAt,
              isActive: true,
            });
            locationsCreated = true;
          } catch (locErr) {
            console.warn(`[CreateClient] Error geocoding location "${name}":`, locErr);
            locationWarnings.push({
              name,
              reason: "Address validation is temporarily unavailable due to a system issue. Add this location again from the client's page in a few minutes.",
            });
          }
        }
      }
      if (locationsCreated) {
        onLocationChanged();
      }
      
      // Task #1941 — Audit-log client creation (and the initial product
      // set) so the History popover has a starting row to render.
      const createAuditEvents: any[] = [];
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        const actorId = userId ?? null;
        const events = createAuditEvents;
        events.push({
          userId: actorId,
          actionType: "client_created",
          route: "/admin/clients",
          actionDetail: `Created client ${client.firmName ?? client.id}`,
          metadata: {
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            products: normalizedProducts,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        });
        for (const p of normalizedProducts) {
          events.push({
            userId: actorId,
            actionType: "product_added",
            route: "/admin/clients",
            actionDetail: `Added product ${p} to ${client.firmName ?? client.id}`,
            metadata: { clientId: client.id, clientFirmName: client.firmName ?? null, product: p },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          });
        }
        await insertActivityLogs(events);
      } catch (logErr: any) {
        console.error("[ClientCreate] Audit log failed:", logErr?.message);
        // Task #1986 — best-effort logging just silently emptied the History
        // popover before; surface a persistent failure to operators (Slack +
        // in-app bell) without letting the alert path break the response.
        try {
          const { recordClientAuditLogWriteFailure } = await import(
            "../services/clientAuditLogFailureAlerts"
          );
          void recordClientAuditLogWriteFailure({
            operation: "create",
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            eventCount: createAuditEvents.length,
            error: logErr,
          });
        } catch (alertErr: any) {
          console.error(
            "[ClientCreate] Audit-log failure alert errored:",
            alertErr?.message ?? alertErr,
          );
        }
      }

      res.status(201).json(
        locationWarnings.length > 0 || teamAssignmentWarning
          ? {
              ...client,
              ...(locationWarnings.length > 0 ? { locationWarnings } : {}),
              ...(teamAssignmentWarning ? { teamAssignmentWarning } : {}),
              teamAssignmentsSeeded,
            }
          : { ...client, teamAssignmentsSeeded },
      );
    } catch (error) {
      console.error("Error creating client:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Update client - Team Lead+ can update any, Account Manager can update their own
  app.patch("/api/clients/:id", isAuthenticated, async (req: AuthenticatedRequest<{ id: string }, Record<string, unknown>>, res) => {
    try {
      const userId = req.user?.claims?.sub;
      // F9: compile-only assertion — behavior is unchanged.
      const user = await storage.getUser(userId!);
      const existingClient = await storage.getClient(req.params.id);
      
      if (!existingClient) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      // Check permissions
      const isAccountManagerPlus = hasRole(user?.role, 'account_manager');
      const isOwner = existingClient.ownerId === userId;
      
      if (!isAccountManagerPlus && !isOwner) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      let updateData = { ...req.body };
      if (!isAccountManagerPlus && updateData.ownerId && updateData.ownerId !== userId) {
        return res.status(403).json({ error: "Only Account Managers and above can reassign clients" });
      }
      
      if (updateData.ownerId === '' || updateData.ownerId === 'unassigned') {
        updateData.ownerId = null;
      }

      // Convert clientStartDate string to Date if provided, or remove if empty
      if (updateData.clientStartDate !== undefined) {
        if (updateData.clientStartDate && typeof updateData.clientStartDate === 'string') {
          updateData.clientStartDate = new Date(updateData.clientStartDate);
        } else if (updateData.clientStartDate === '' || updateData.clientStartDate === null) {
          updateData.clientStartDate = null;
        }
      }
      
      if (updateData.isArchived !== undefined && !isAccountManagerPlus) {
        return res.status(403).json({ error: "Only Team Leads can archive clients" });
      }

      // The demo-account flag hides a client from every churn/dashboard
      // aggregation (they all filter COALESCE(is_demo, false) = false), so
      // flipping it silently reshapes the whole board — CEO only.
      if (updateData.isDemo !== undefined && user?.role !== 'ceo') {
        return res.status(403).json({ error: "Only the CEO can change the demo-account flag" });
      }

      if (updateData.products !== undefined) {
        if (!Array.isArray(updateData.products)) {
          return res.status(400).json({ error: "At least one product is required. Clients cannot have an empty products list." });
        }
        const { validateProductList, CANONICAL_PRODUCTS } = await import("../utils/productResolution");
        const { normalized: normalizedProducts, invalid: invalidProducts } = validateProductList(updateData.products);
        if (invalidProducts.length > 0) {
          return res.status(400).json({
            error: "Unknown product value(s) submitted. Allowed products: " + CANONICAL_PRODUCTS.join(", ") + ".",
            code: "INVALID_PRODUCTS",
            invalid: invalidProducts,
            allowed: [...CANONICAL_PRODUCTS],
          });
        }
        if (normalizedProducts.length === 0) {
          return res.status(400).json({ error: "At least one product is required. Clients cannot have an empty products list." });
        }
        updateData.products = normalizedProducts;
      }

      // Task #867 — normalise the per-client trusted-domain list and bust the
      // hard-match index cache so the next email matcher run sees the change.
      if (updateData.emailDomains !== undefined) {
        const { normalizeClientEmailDomains } = await import("@shared/models/clients");
        updateData.emailDomains = normalizeClientEmailDomains(updateData.emailDomains);
      }

      // F8 (Task #4153) — the role gates above inspect the RAW body on
      // purpose (they must 403 even when the field value would fail
      // validation); everything that reaches the write goes through the
      // shared client schema so unknown keys are stripped and
      // id / clientCode / createdAt / updatedAt can never be set through
      // this route. .partial() keeps PATCH semantics: omitted fields stay
      // untouched, explicit nulls still clear nullable columns.
      const parsedUpdate = insertClientSchema.partial().safeParse(updateData);
      if (!parsedUpdate.success) {
        return res.status(400).json({ error: parsedUpdate.error.issues });
      }
      updateData = parsedUpdate.data;

      // Task #4790 — vendor/receipt identifiers are never client identifiers.
      // Same refusal as create: trusted-domain edits and the legacy primary
      // contact email must not re-poison client identity data.
      if (updateData.emailDomains !== undefined || updateData.contactEmail) {
        const { findVendorIdentifierViolations, vendorIdentifierRefusalMessage } = await import(
          "../services/seedingTrustPolicy"
        );
        const violations = findVendorIdentifierViolations({
          emailDomains: updateData.emailDomains,
          emails: updateData.contactEmail ? [updateData.contactEmail] : undefined,
        });
        if (violations.length > 0) {
          return res.status(400).json({
            error: vendorIdentifierRefusalMessage(violations),
            code: "VENDOR_IDENTIFIER_REFUSED",
            violations,
          });
        }
      }

      const client = await storage.updateClient(req.params.id, updateData);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      // Task #4329 — rule tags + segment membership evaluate on write
      // (never fails the write; the periodic sweep heals any miss).
      const { evaluateRecordWriteSafe } = await import("../services/tagSegmentEngine");
      await evaluateRecordWriteSafe("client", client.id);

      // Archive/restore side effects (comms channel archive/restore) live in
      // the shared helper so this manual flow and the Task #3711 offboarding
      // sweep can't drift. Fire-and-forget — the helper never throws, and a
      // comms failure must never block the client update.
      if (updateData.isArchived === true || updateData.isArchived === false) {
        void applyClientArchivalSideEffects(client, updateData.isArchived);
      }

      // Task #1941 — Audit-log the client edit + per-product diff so the
      // ClientDetail "History" popover and the product-list popover have
      // actor + timestamp rows to render. Same shape as Task #1912's
      // user_deleted / user_restored entries.
      const updateAuditEvents: any[] = [];
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        const actorId = userId ?? null;
        const events = updateAuditEvents;
        events.push({
          userId: actorId,
          actionType: "client_updated",
          route: `/clients/${client.id}`,
          actionDetail: `Updated client ${client.firmName ?? client.id}`,
          metadata: {
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            changedKeys: Object.keys(updateData),
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        });
        if (updateData.products !== undefined) {
          const before = new Set((existingClient.products ?? []) as string[]);
          const after = new Set((updateData.products ?? []) as string[]);
          for (const p of after) {
            if (!before.has(p)) {
              events.push({
                userId: actorId,
                actionType: "product_added",
                route: `/clients/${client.id}`,
                actionDetail: `Added product ${p} to ${client.firmName ?? client.id}`,
                metadata: { clientId: client.id, clientFirmName: client.firmName ?? null, product: p },
                sessionId: null,
                duration: null,
                timestamp: new Date(),
              });
            }
          }
          for (const p of before) {
            if (!after.has(p)) {
              events.push({
                userId: actorId,
                actionType: "product_removed",
                route: `/clients/${client.id}`,
                actionDetail: `Removed product ${p} from ${client.firmName ?? client.id}`,
                metadata: { clientId: client.id, clientFirmName: client.firmName ?? null, product: p },
                sessionId: null,
                duration: null,
                timestamp: new Date(),
              });
            }
          }
        }
        await insertActivityLogs(events);
      } catch (logErr: any) {
        console.error("[ClientUpdate] Audit log failed:", logErr?.message);
        // Task #1986 — surface a persistent logging failure to operators so a
        // broken History path is noticed instead of quietly losing edit rows.
        try {
          const { recordClientAuditLogWriteFailure } = await import(
            "../services/clientAuditLogFailureAlerts"
          );
          void recordClientAuditLogWriteFailure({
            operation: "update",
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            eventCount: updateAuditEvents.length,
            error: logErr,
          });
        } catch (alertErr: any) {
          console.error(
            "[ClientUpdate] Audit-log failure alert errored:",
            alertErr?.message ?? alertErr,
          );
        }
      }

      if (updateData.emailDomains !== undefined) {
        try {
          const { invalidateHardMatchIndexes } = await import("../services/frontHardMatch");
          invalidateHardMatchIndexes();
        } catch (err) {
          console.warn("[Clients] hard-match index invalidation failed:", err);
        }
        // Task #4762 — trusted-domain edits drain their own backlog: kick the
        // scoped deterministic re-match for THIS client immediately (indexes
        // were just invalidated above, so the drain sees the new domains); the
        // 6h-enrolled full-backlog re-match remains the backstop. Non-fatal:
        // a feeder failure must never break the client edit itself.
        if (Array.isArray(updateData.emailDomains) && updateData.emailDomains.length > 0) {
          try {
            const { enqueueRetroactiveReprocessSafe, periodicDedupeKey } = await import(
              "../services/retroactiveReprocessControl"
            );
            await enqueueRetroactiveReprocessSafe({
              clientId: client.id,
              source: "client_domain_edit",
              workloadClass: "interactive_repair",
              dedupeKey: periodicDedupeKey(client.id),
            });
          } catch (err: any) {
            console.warn(
              "[Clients] domain-edit re-match enqueue failed (non-fatal):",
              err?.message ?? err,
            );
          }
        }
      }

      res.json(client);
    } catch (error) {
      console.error("Error updating client:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── Task #3711: client offboarding ────────────────────────────────────
  // Schedule (or move) a client's offboarding: the operator picks the final
  // day of service, and the daily sweep auto-archives the client on that day
  // (America/New_York). Same role gate as the archive action above.
  app.post("/api/clients/:id/offboarding", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager')) {
        return res.status(403).json({ error: "Only Team Leads can schedule client offboarding" });
      }
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (client.isArchived) {
        return res.status(400).json({ error: "Client is already archived" });
      }

      const finalServiceDate = req.body?.finalServiceDate;
      if (typeof finalServiceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(finalServiceDate)) {
        return res.status(400).json({ error: "finalServiceDate must be a YYYY-MM-DD date" });
      }
      const parsed = new Date(`${finalServiceDate}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== finalServiceDate) {
        return res.status(400).json({ error: "finalServiceDate is not a valid calendar date" });
      }
      // Today (NY) is allowed — the next sweep archives immediately. Past is not.
      if (finalServiceDate < todayInNewYork()) {
        return res.status(400).json({ error: "finalServiceDate cannot be in the past" });
      }

      const { offboarding, action, previousFinalServiceDate } = await scheduleClientOffboarding(
        client.id,
        finalServiceDate,
        userId ?? null,
      );

      // Audit — same shape as the client CRUD events (History popover).
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        await insertActivityLogs([{
          userId: userId ?? null,
          actionType: action === "initiated" ? "client_offboarding_scheduled" : "client_offboarding_rescheduled",
          route: `/clients/${client.id}`,
          actionDetail: action === "initiated"
            ? `Scheduled offboarding for ${client.firmName ?? client.id} — final day of service ${finalServiceDate}`
            : `Moved offboarding for ${client.firmName ?? client.id} — final day of service ${previousFinalServiceDate} → ${finalServiceDate}`,
          metadata: {
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            finalServiceDate,
            previousFinalServiceDate,
            offboardingId: offboarding.id,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[ClientOffboarding] Audit log failed:", logErr?.message ?? logErr);
      }

      res.status(action === "initiated" ? 201 : 200).json({ offboarding, action });
    } catch (error) {
      if (error instanceof OffboardingExecutingError) {
        // The daily sweep claimed this record and is executing the pipeline
        // right now — the date can no longer be changed.
        return res.status(409).json({
          error: "This client's offboarding is executing right now and can no longer be changed",
        });
      }
      console.error("Error scheduling client offboarding:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Cancel a client's scheduled offboarding (any time before it runs).
  app.delete("/api/clients/:id/offboarding", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager')) {
        return res.status(403).json({ error: "Only Team Leads can cancel client offboarding" });
      }
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const cancelled = await cancelScheduledOffboarding(client.id, userId ?? null);
      if (!cancelled) {
        // Distinguish "nothing to cancel" from "the sweep claimed it and is
        // executing right now" (cancel only acts on `scheduled` records).
        const active = await getActiveOffboardingForClient(client.id);
        if (active?.status === "processing") {
          return res.status(409).json({
            error: "This client's offboarding is executing right now and can no longer be cancelled",
          });
        }
        return res.status(404).json({ error: "No scheduled offboarding for this client" });
      }

      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        await insertActivityLogs([{
          userId: userId ?? null,
          actionType: "client_offboarding_cancelled",
          route: `/clients/${client.id}`,
          actionDetail: `Cancelled offboarding for ${client.firmName ?? client.id} (was scheduled for ${cancelled.finalServiceDate})`,
          metadata: {
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            finalServiceDate: cancelled.finalServiceDate,
            offboardingId: cancelled.id,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[ClientOffboarding] Audit log failed:", logErr?.message ?? logErr);
      }

      res.json({ offboarding: cancelled });
    } catch (error) {
      console.error("Error cancelling client offboarding:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Delete client - Team Lead+ only (demo clients CEO only)
  app.delete("/api/clients/:id", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.id);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      // Demo clients can only be deleted by CEO
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (client.isDemo && user?.role !== 'ceo') {
        return res.status(403).json({ error: "Demo clients can only be deleted by CEO" });
      }
      
      await storage.deleteClient(req.params.id);

      // Task #4329 — reap the deleted client's segment-membership cache
      // rows inline (they have no FK; contact rows cascade-deleted with
      // the client are reaped by the periodic sweep's orphan pass).
      const { pruneSegmentMembershipSafe } = await import("../services/tagSegmentEngine");
      await pruneSegmentMembershipSafe(req.params.id);

      // Task #1941 — Audit-log the delete so the History popover can
      // show who removed a client (mirrors Task #1912's user_deleted).
      try {
        const { insertActivityLogs } = await import("../storage/activityStorage");
        await insertActivityLogs([{
          userId: userId ?? null,
          actionType: "client_deleted",
          route: "/admin/clients",
          actionDetail: `Deleted client ${client.firmName ?? client.id}`,
          metadata: {
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            clientCode: client.clientCode ?? null,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[ClientDelete] Audit log failed:", logErr?.message);
        // Task #1986 — surface a persistent logging failure so a deleted
        // client doesn't silently vanish from the History timeline.
        try {
          const { recordClientAuditLogWriteFailure } = await import(
            "../services/clientAuditLogFailureAlerts"
          );
          void recordClientAuditLogWriteFailure({
            operation: "delete",
            clientId: client.id,
            clientFirmName: client.firmName ?? null,
            eventCount: 1,
            error: logErr,
          });
        } catch (alertErr: any) {
          console.error(
            "[ClientDelete] Audit-log failure alert errored:",
            alertErr?.message ?? alertErr,
          );
        }
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error deleting client:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // CLIENT LOCATIONS API
  // ============================================
  
  // Get locations for a client
  app.get("/api/clients/:clientId/locations", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Check access
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const locations = await storage.getClientLocations(req.params.clientId);
      res.json(locations);
    } catch (error) {
      console.error("Error fetching client locations:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Create location for a client
  app.post("/api/clients/:clientId/locations", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Check access
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      if (!req.body.name || typeof req.body.name !== 'string') {
        return res.status(400).json({ error: "Location name is required" });
      }
      
      if (!req.body.address || typeof req.body.address !== 'string' || req.body.address.trim().length < 10) {
        return res.status(400).json({ error: "A full street address is required — include street, city, state, and ZIP (e.g. 123 Main St, Dallas, TX 75201)." });
      }
      
      const { geocodeLocationText } = await import("../mcu/geocoding");
      const geocoded = await geocodeLocationText(req.body.name.trim(), req.body.address.trim());

      if (geocoded.lat == null || geocoded.lng == null) {
        // Distinguish an address the geocoder couldn't find (operator should fix
        // it) from a quota/key/provider fault (a system issue, not their input).
        if (geocoded.geocodeFailureReason === "system") {
          return res.status(503).json({ error: "Address validation is temporarily unavailable due to a system issue (not your address). Please try again in a few minutes." });
        }
        return res.status(400).json({ error: "We couldn't find that address. Please enter a complete, valid US street address (street, city, state, and ZIP)." });
      }
      
      const locationData = {
        name: geocoded.name,
        clientId: req.params.clientId,
        address: geocoded.address,
        city: geocoded.city,
        state: geocoded.state,
        lat: geocoded.lat,
        lng: geocoded.lng,
        stateFips: geocoded.stateFips,
        countyFips: geocoded.countyFips,
        geocodedAt: geocoded.geocodedAt,
        isActive: req.body.isActive ?? true,
      };
      
      const location = await storage.createClientLocation(locationData, {
        actorUserId: req.user?.claims?.sub ?? null,
        source: "operator_ui",
        reason: `POST /api/clients/${req.params.clientId}/locations`,
      });

      if (location.lat && location.lng) {
        onLocationChanged();
      }

      res.status(201).json(location);
    } catch (error) {
      console.error("Error creating client location:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Update location
  app.patch("/api/clients/:clientId/locations/:locationId", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Check access
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const updateData: Record<string, unknown> = {};
      if (req.body.name !== undefined) updateData.name = req.body.name;
      if (req.body.isActive !== undefined) updateData.isActive = req.body.isActive;
      
      // If address is being updated, re-geocode
      if (req.body.address !== undefined) {
        if (!req.body.address || typeof req.body.address !== 'string' || req.body.address.trim().length < 10) {
          return res.status(400).json({ error: "A valid full address is required (street, city, state, zip)" });
        }
        
        let geocodeResult = null;
        try {
          const { geocodeAddress } = await import("../mcu/geocoding");
          geocodeResult = await geocodeAddress(req.body.address.trim());
          if (!geocodeResult.success) {
            return res.status(400).json({ error: "Could not validate address. Please enter a valid US address." });
          }
        } catch (geocodeError) {
          console.error("Geocoding error:", geocodeError);
          return res.status(400).json({ error: "Could not validate address. Please enter a valid US address." });
        }
        
        // Parse city and state from formatted address
        let city = null;
        let state = null;
        if (geocodeResult?.formattedAddress) {
          const parts = geocodeResult.formattedAddress.split(",").map((p: string) => p.trim());
          if (parts.length >= 3) {
            city = parts[parts.length - 3];
            const stateZip = parts[parts.length - 2];
            state = stateZip?.split(" ")[0] || null;
          }
        }
        
        let fipsResult = null;
        if (geocodeResult?.lat && geocodeResult?.lng) {
          try {
            const { getFipsForLocation } = await import("../mcu/fips");
            fipsResult = await getFipsForLocation({ lat: geocodeResult.lat, lng: geocodeResult.lng });
          } catch (fipsError) {
            console.error("FIPS lookup error:", fipsError);
          }
        }
        
        updateData.address = geocodeResult?.formattedAddress || req.body.address.trim();
        updateData.city = city;
        updateData.state = state;
        updateData.lat = geocodeResult?.lat || null;
        updateData.lng = geocodeResult?.lng || null;
        updateData.stateFips = fipsResult?.stateFips || null;
        updateData.countyFips = fipsResult?.countyFips || null;
        updateData.geocodedAt = new Date();
      }
      
      const location = await storage.updateClientLocation(req.params.locationId, updateData, {
        actorUserId: req.user?.claims?.sub ?? null,
        source: "operator_ui",
        reason: `PATCH /api/clients/${req.params.clientId}/locations/${req.params.locationId}`,
      });
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      onLocationChanged();
      res.json(location);
    } catch (error) {
      console.error("Error updating client location:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Delete location
  app.delete("/api/clients/:clientId/locations/:locationId", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      // Check access
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      await storage.deleteClientLocation(req.params.locationId, {
        actorUserId: req.user?.claims?.sub ?? null,
        source: "operator_ui",
        reason: `DELETE /api/clients/${req.params.clientId}/locations/${req.params.locationId}`,
      });
      onLocationChanged();
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting client location:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // CLIENT DATA ACCESS API
  // ============================================
  app.get("/api/clients/:clientId/data-access", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const dataAccess = await storage.getClientDataAccess(req.params.clientId);
      res.json(dataAccess);
    } catch (error) {
      console.error("Error fetching client data access:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #2418 — advisory per-client data-presence detection. Reads only
  // already-ingested local tables (no new external calls) and never flips a
  // flag; the report uses it to nudge "looks like you already have this —
  // mark it Available?" instead of flatly warning the data is missing.
  app.get("/api/clients/:clientId/data-access/detection", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);

      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { detectClientDataPresence } = await import("../services/dataAccessDetection");
      const detection = await detectClientDataPresence(req.params.clientId);
      res.json(detection);
    } catch (error) {
      console.error("Error detecting client data presence:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/all-data-access", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      if (user?.role !== 'ceo') {
        return res.status(403).json({ error: "CEO access required" });
      }
      
      const clients = await storage.getClients();
      const clientIds = clients.map(c => c.id);
      const allDataAccess = await storage.getAllDataAccessForClients(clientIds);
      
      res.json(allDataAccess);
    } catch (error) {
      console.error("Error fetching all data access:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Lists clients that have one or more saved locations with no map
  // coordinates (lat/lng null). These were created before address validation
  // existed and are silently excluded from MCU capacity analysis. Powers the
  // operator-facing "needs attention" banner on Client Management.
  app.get("/api/admin/locations/ungeocoded", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager')) {
        return res.status(403).json({ error: "Account manager access required" });
      }

      const { clientLocations, clients } = await import("@shared/schema");
      const { isNull, or, eq } = await import("drizzle-orm");

      const rows = await db
        .select({
          locationId: clientLocations.id,
          locationName: clientLocations.name,
          address: clientLocations.address,
          clientId: clients.id,
          firmName: clients.firmName,
          clientCode: clients.clientCode,
          isArchived: clients.isArchived,
        })
        .from(clientLocations)
        .innerJoin(clients, eq(clientLocations.clientId, clients.id))
        .where(or(isNull(clientLocations.lat), isNull(clientLocations.lng)));

      const byClient = new Map<string, {
        clientId: string;
        firmName: string;
        clientCode: string | null;
        isArchived: boolean;
        locations: Array<{ id: string; name: string; address: string | null }>;
      }>();

      for (const r of rows) {
        if (r.isArchived) continue;
        let entry = byClient.get(r.clientId);
        if (!entry) {
          entry = {
            clientId: r.clientId,
            firmName: r.firmName,
            clientCode: r.clientCode,
            isArchived: !!r.isArchived,
            locations: [],
          };
          byClient.set(r.clientId, entry);
        }
        entry.locations.push({ id: r.locationId, name: r.locationName, address: r.address });
      }

      const clientsOut = Array.from(byClient.values()).sort((a, b) =>
        a.firmName.localeCompare(b.firmName)
      );
      const totalLocations = clientsOut.reduce((sum, c) => sum + c.locations.length, 0);

      res.json({ clients: clientsOut, totalClients: clientsOut.length, totalLocations });
    } catch (error) {
      console.error("Error fetching ungeocoded locations:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/locations/backfill-geocode", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager')) {
        return res.status(403).json({ error: "Account manager access required" });
      }

      const { clientLocations } = await import("@shared/schema");
      const { isNull, or } = await import("drizzle-orm");
      const { geocodeLocationText } = await import("../mcu/geocoding");

      const ungeocodedLocations = await db.select().from(clientLocations)
        .where(or(isNull(clientLocations.lat), isNull(clientLocations.lng)));

      const results: Array<{ id: string; originalName: string; status: string; newName?: string; warning?: string }> = [];

      for (const loc of ungeocodedLocations) {
        try {
          const geocoded = loc.address && loc.address.trim().length > 10
              ? await geocodeLocationText(loc.name, loc.address.trim())
              : await geocodeLocationText(loc.name);

          if (geocoded.lat != null && geocoded.lng != null) {
            await db.update(clientLocations)
              .set({
                name: geocoded.name,
                address: geocoded.address,
                city: geocoded.city,
                state: geocoded.state,
                lat: geocoded.lat,
                lng: geocoded.lng,
                stateFips: geocoded.stateFips,
                countyFips: geocoded.countyFips,
                geocodedAt: geocoded.geocodedAt,
              })
              .where(sql`id = ${loc.id}`);

            results.push({
              id: loc.id,
              originalName: loc.name,
              status: "geocoded",
              newName: geocoded.name !== loc.name ? geocoded.name : undefined,
            });
          } else {
            results.push({
              id: loc.id,
              originalName: loc.name,
              status: "failed",
              warning: geocoded.geocodeWarning || "Could not geocode",
            });
          }
        } catch (err: any) {
          results.push({
            id: loc.id,
            originalName: loc.name,
            status: "error",
            warning: err.message,
          });
        }
      }

      const geocoded = results.filter(r => r.status === "geocoded").length;
      const failed = results.filter(r => r.status !== "geocoded").length;

      if (geocoded > 0) {
        onLocationChanged();
      }

      res.json({
        total: ungeocodedLocations.length,
        geocoded,
        failed,
        results,
      });
    } catch (error) {
      console.error("Error in location backfill:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.put("/api/clients/:clientId/data-access/:category", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }
      
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const { status, notes } = req.body;
      const record = await storage.upsertClientDataAccess({
        clientId: req.params.clientId,
        category: req.params.category,
        status,
        notes,
      });
      res.json(record);
    } catch (error) {
      console.error("Error updating client data access:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #778: Surface clients whose stored `products` column contains values
  // that would now fail strict `validateProductList` validation. Same logic as
  // the one-shot CLI audit at `scripts/audit-client-products.ts`, exposed
  // read-only to admins so cleanup is discoverable from the UI.
  app.get("/api/admin/clients/invalid-products", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { clients } = await import("@shared/schema");
      const { validateProductList } = await import("@shared/productResolution");

      const isCeo = user.role === "ceo";

      const rows = await db
        .select({
          id: clients.id,
          clientCode: clients.clientCode,
          firmName: clients.firmName,
          products: clients.products,
          isArchived: clients.isArchived,
          isDemo: clients.isDemo,
        })
        .from(clients);

      const offenders = rows
        // Match the same demo-client visibility policy used by /api/clients
        // and /api/clients/:id: only CEO can see demo clients.
        .filter((r) => isCeo || !r.isDemo)
        .map((r) => {
          const stored = Array.isArray(r.products) ? (r.products as string[]) : [];
          const { invalid } = validateProductList(stored);
          return { row: r, stored, invalid };
        })
        .filter((o) => o.invalid.length > 0)
        .map((o) => ({
          id: o.row.id,
          clientCode: o.row.clientCode,
          firmName: o.row.firmName,
          storedProducts: o.stored,
          invalidValues: o.invalid,
          isArchived: !!o.row.isArchived,
        }));

      res.json({ scanned: rows.length, offenders });
    } catch (error) {
      console.error("Error auditing client products:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/migrate-product-types", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user || user.role !== 'ceo') {
        return res.status(403).json({ error: "CEO only" });
      }

      const { normalizeProductList } = await import("../utils/productResolution");

      const dryRun = req.query.dryRun === 'true';

      const allPanels = await db.execute(sql`
        SELECT cp.id as panel_id, cp.client_id, cp.product_types,
               c.firm_name, c.products as client_products
        FROM command_panels cp
        JOIN clients c ON c.id = cp.client_id
      `);

      const results: Array<{firmName: string; action: string; cpProducts: string[]; clientProductsBefore: string[]; clientProductsAfter: string[]}> = [];

      for (const row of allPanels.rows) {
        const cpProducts = (row.product_types as string[]) || [];
        const clientProductsBefore = (row.client_products as string[]) || [];
        const canonical = normalizeProductList(cpProducts);

        const beforeSorted = [...clientProductsBefore].sort().join(',');
        const afterSorted = [...canonical].sort().join(',');

        if (beforeSorted !== afterSorted) {
          if (!dryRun) {
            await db.execute(sql`
              UPDATE clients SET products = ${canonical.length > 0 ? canonical : sql`'{}'::text[]`}
              WHERE id = ${row.client_id}
            `);
          }
          results.push({
            firmName: row.firm_name as string,
            action: dryRun ? 'would_update' : 'updated',
            cpProducts,
            clientProductsBefore,
            clientProductsAfter: [...canonical],
          });
        }
      }

      res.json({ dryRun, synced: results.length, total: allPanels.rows.length, results });
    } catch (error) {
      console.error("Error migrating product types:", error);
      res.status(500).json({ error: "Migration failed" });
    }
  });
  }
  
