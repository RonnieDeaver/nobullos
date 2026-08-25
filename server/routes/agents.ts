import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireTeamLead, requireAccountManager, hasRole, openai, requireCommandCenterAccess } from "./middleware";
import type { ValidatedBodyRequest } from "./requestContext";
import { canAccessChurnCommandCenter } from "../auth/permissions";
import { CHEAP_MODEL } from "../aiModels";
import { toAccountRatingPresentation } from "../services/judgmentTierGate";

type DailyJudgmentRunner = () => Promise<unknown>;

// The HTTP route owns only admission and acknowledgement; the service owns
// the background portfolio run. This override keeps that boundary testable
// without ever starting real client work from a route-auth test.
let dailyJudgmentRunnerForTest: DailyJudgmentRunner | null = null;

export function __setDailyJudgmentRunnerForTest(runner: DailyJudgmentRunner | null): void {
  dailyJudgmentRunnerForTest = runner;
}

async function startDailyJudgmentRun(): Promise<unknown> {
  if (dailyJudgmentRunnerForTest) return dailyJudgmentRunnerForTest();
  const { runDailyJudgmentCron } = await import("../services/dailyJudgment");
  return runDailyJudgmentCron();
}

function withAccountRating<T extends {
  status?: unknown;
  relationshipHealth?: unknown;
  relationshipStatus?: unknown;
  riskScore?: unknown;
  judgmentDate?: unknown;
  dataSourcesSummary?: unknown;
}>(judgment: T): T & {
  rating: ReturnType<typeof toAccountRatingPresentation>;
} {
  return {
    ...judgment,
    rating: toAccountRatingPresentation({
      status: judgment.status,
      relationship: judgment.relationshipHealth ?? judgment.relationshipStatus,
      riskScore: judgment.riskScore,
      judgmentDate: judgment.judgmentDate,
      dataSourcesSummary: judgment.dataSourcesSummary,
    }),
  };
}

// F8 (Task #4153) — PUT /api/clients/:clientId/agent-memory/:id boundary.
// Only the operator-editable identifier fields may cross into the update;
// ownership (clientId), provenance (source, manuallyAdded, learnedFromMatchId),
// usage counters, and server timestamps stay server-managed. Unknown keys are
// stripped (repo-wide zod default), matching the pre-existing convention.
const updateAgentMemorySchema = z.object({
  identifierType: z.string().min(1).optional(),
  identifierValue: z.string().min(1).optional(),
  confidenceWeight: z.number().finite().optional(),
});
  
  // #661: enrich agent_match_decisions rows with reviewer display info (so
  // the audit trail can attribute Command Panel claims to the user who made
  // them) and the assigned client's display name (so reviewers can see which
  // client the recording was claimed for without having to look up the ID).
  // Both lookups are best-effort and fall back to ID-only display on error.
  async function enrichDecisionsWithReviewerAndClient<
    T extends {
      reviewedByUserId: string | null;
      clientId: string | null;
      correctedToClientId?: string | null;
      priorClientId?: string | null;
    },
  >(decisions: T[]): Promise<Array<T & {
    reviewedByName: string | null;
    reviewedByEmail: string | null;
    clientName: string | null;
    correctedToClientName?: string | null;
    priorClientName?: string | null;
  }>> {
    const reviewerIds = Array.from(
      new Set(
        decisions
          .map((d) => d.reviewedByUserId)
          .filter((v): v is string => !!v),
      ),
    );
    const reviewerMap = new Map<string, { name: string | null; email: string | null }>();
    if (reviewerIds.length > 0) {
      try {
        const users = await Promise.all(
          reviewerIds.map((id) => storage.getUser(id).catch(() => null)),
        );
        for (const u of users) {
          if (!u) continue;
          const name =
            [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
            u.email ||
            null;
          reviewerMap.set(u.id, { name, email: u.email ?? null });
        }
      } catch {
        // best-effort enrichment; fall back to ID-only display
      }
    }
    const clientIds = Array.from(
      new Set(
        decisions
          .flatMap((d) => [d.clientId, d.correctedToClientId, d.priorClientId])
          .filter((v): v is string => !!v),
      ),
    );
    const clientMap = new Map<string, string>();
    if (clientIds.length > 0) {
      try {
        const clients = await Promise.all(
          clientIds.map((id) => storage.getClient(id).catch(() => null)),
        );
        for (const c of clients) {
          if (!c) continue;
          const name = c.firmName ?? c.clientCode ?? null;
          if (name) clientMap.set(c.id, name);
        }
      } catch {
        // best-effort enrichment; fall back to ID-only display
      }
    }
    return decisions.map((d) => {
      const r = d.reviewedByUserId ? reviewerMap.get(d.reviewedByUserId) : null;
      return {
        ...d,
        reviewedByName: r?.name ?? null,
        reviewedByEmail: r?.email ?? null,
        clientName: d.clientId ? clientMap.get(d.clientId) ?? null : null,
        correctedToClientName: d.correctedToClientId ? clientMap.get(d.correctedToClientId) ?? null : null,
        priorClientName: d.priorClientId ? clientMap.get(d.priorClientId) ?? null : null,
      };
    });
  }

  // Task #2637: the comparative-semantic metrics reset / test-alert handlers
  // were removed along with their routes — they read live counters from the
  // deleted agentMatchingEngine (AI matcher telemetry).

  export function registerAgentRoutes(app: Express) {
    // ============================================
  // CLIENT CONTACTS
  // ============================================

  app.get("/api/clients/:clientId/contacts", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const contacts = await storage.getClientContacts(req.params.clientId);
      res.json(contacts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #991: latest audit row per contact for this client. The UI uses
  // this to render "Last edited by Jane Doe · 2h ago" beside every contact
  // without forcing one query per row.
  app.get("/api/clients/:clientId/contacts/audit", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const rows = await storage.getLatestClientContactAuditByClient(req.params.clientId);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #999: latest audit row per location for this client. The UI
  // uses this to render "Last edited by Jane Doe · 2h ago" beside every
  // GBP location row without forcing one query per row. Mirrors the
  // contacts/audit endpoint above.
  app.get("/api/clients/:clientId/locations/audit", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const rows = await storage.getLatestClientLocationAuditByClient(req.params.clientId);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #999: full edit history for a single location.
  app.get("/api/clients/:clientId/locations/:id/audit", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const existing = await storage.getClientLocation(req.params.id);
      if (existing && existing.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Location not found" });
      }
      const history = await storage.getClientLocationAuditHistory(req.params.id, req.params.clientId);
      if (!existing && history.length === 0) {
        return res.status(404).json({ error: "Location not found" });
      }
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #991: full edit history for a single contact.
  app.get("/api/clients/:clientId/contacts/:id/audit", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      // Make sure the contact actually belongs to this client before
      // exposing its audit history. Audit rows are kept after a delete,
      // so when the contact has already been removed we fall back to
      // matching the audit table itself.
      const existing = await storage.getClientContact(req.params.id);
      if (existing && existing.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const history = await storage.getClientContactAuditHistory(req.params.id, req.params.clientId);
      if (!existing && history.length === 0) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/contacts", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { insertClientContactSchema } = await import("@shared/schema");
      const body = { ...req.body, clientId: req.params.clientId };
      // Strip the optimistic-concurrency token if a client accidentally sends
      // one on a create — it has no meaning for INSERT and would fail Zod.
      delete body.expectedUpdatedAt;
      if (body.email && !body.emails) body.emails = [body.email];
      if (body.phone && !body.phones) body.phones = [body.phone];
      delete body.email;
      delete body.phone;
      if (Array.isArray(body.emails)) body.emails = body.emails.map((e: string) => e.trim()).filter(Boolean);
      if (Array.isArray(body.phones)) body.phones = body.phones.map((p: string) => p.trim()).filter(Boolean);
      // Task #4790 — vendor/receipt senders are never client identifiers;
      // refuse them here so contact rows can't be (re-)poisoned directly.
      {
        const { findVendorIdentifierViolations, vendorIdentifierRefusalMessage } = await import(
          "../services/seedingTrustPolicy"
        );
        const violations = findVendorIdentifierViolations({ emails: body.emails });
        if (violations.length > 0) {
          return res.status(400).json({
            error: vendorIdentifierRefusalMessage(violations),
            code: "VENDOR_IDENTIFIER_REFUSED",
            violations,
          });
        }
      }
      const data = insertClientContactSchema.parse(body);
      const actorUserId = req.user?.claims?.sub || req.user?.id || null;
      const contact = await storage.createClientContact(data, {
        actorUserId,
        source: "operator_ui",
        reason: `POST /api/clients/${req.params.clientId}/contacts`,
      });

      // Task #4329 — contact segments evaluate on write (never throws).
      {
        const { evaluateRecordWriteSafe } = await import("../services/tagSegmentEngine");
        await evaluateRecordWriteSafe("contact", contact.id);
      }

      // Task #1574 — create-contact returns 201 Created per REST conventions.
      res.status(201).json(contact);

      setImmediate(async () => {
        try {
          // Task #1025: per-client ceiling — refuses to enqueue past
          // RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX so a burst of
          // contact edits can't pile duplicate jobs onto an already
          // backlogged client.
          const { enqueueRetroactiveReprocessSafe } = await import(
            "../services/retroactiveReprocessControl"
          );
          await enqueueRetroactiveReprocessSafe({
            clientId: req.params.clientId,
            source: "contact_add",
            workloadClass: "interactive_repair",
            maxAttempts: 2,
          });
        } catch (matchErr: any) {
          console.error(`[Contacts] Auto-match after contact add failed for client ${req.params.clientId}:`, matchErr.message);
        }
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/clients/:clientId/contacts/:id", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const existing = await storage.getClientContact(req.params.id);
      if (!existing || existing.clientId !== req.params.clientId) return res.status(404).json({ error: "Contact not found" });
      const body = { ...req.body };
      // Optimistic-concurrency token. Clients should send the
      // `updatedAt` value they originally loaded; if it doesn't match
      // what's in the DB right now, we 409 instead of overwriting a
      // fresher save (the "I deleted that email and it came back" bug).
      const expectedUpdatedAt = body.expectedUpdatedAt ?? null;
      delete body.expectedUpdatedAt;
      if (body.email && !body.emails) body.emails = [body.email];
      if (body.phone && !body.phones) body.phones = [body.phone];
      delete body.email;
      delete body.phone;
      if (Array.isArray(body.emails)) body.emails = body.emails.map((e: string) => e.trim()).filter(Boolean);
      if (Array.isArray(body.phones)) body.phones = body.phones.map((p: string) => p.trim()).filter(Boolean);
      // Task #4790 — vendor/receipt senders are never client identifiers;
      // refuse them on update too (same policy as create).
      {
        const { findVendorIdentifierViolations, vendorIdentifierRefusalMessage } = await import(
          "../services/seedingTrustPolicy"
        );
        const violations = findVendorIdentifierViolations({ emails: body.emails });
        if (violations.length > 0) {
          return res.status(400).json({
            error: vendorIdentifierRefusalMessage(violations),
            code: "VENDOR_IDENTIFIER_REFUSED",
            violations,
          });
        }
      }
      const actorUserId = req.user?.claims?.sub || req.user?.id || null;
      let contact;
      try {
        contact = await storage.updateClientContact(req.params.id, body, {
          actorUserId,
          source: "operator_ui",
          reason: `PUT /api/clients/${req.params.clientId}/contacts/${req.params.id}`,
          expectedUpdatedAt,
        });
      } catch (concurrencyErr: any) {
        if (concurrencyErr?.code === "OPTIMISTIC_CONCURRENCY_CONFLICT") {
          const fresh = await storage.getClientContact(req.params.id);
          return res.status(409).json({
            error: "Contact was modified by someone else. Refresh and try again.",
            code: "OPTIMISTIC_CONCURRENCY_CONFLICT",
            currentUpdatedAt: concurrencyErr.currentUpdatedAt ?? fresh?.updatedAt ?? null,
            current: fresh ?? null,
          });
        }
        throw concurrencyErr;
      }
      if (!contact) return res.status(404).json({ error: "Contact not found" });

      // Task #4329 — contact segments evaluate on write (never throws).
      {
        const { evaluateRecordWriteSafe } = await import("../services/tagSegmentEngine");
        await evaluateRecordWriteSafe("contact", contact.id);
      }

      res.json(contact);

      setImmediate(async () => {
        try {
          // Task #1025: per-client ceiling (see contact-add comment).
          const { enqueueRetroactiveReprocessSafe } = await import(
            "../services/retroactiveReprocessControl"
          );
          await enqueueRetroactiveReprocessSafe({
            clientId: req.params.clientId,
            source: "contact_update",
            workloadClass: "interactive_repair",
            maxAttempts: 2,
          });
        } catch (matchErr: any) {
          console.error(`[Contacts] Auto-match after contact update failed for client ${req.params.clientId}:`, matchErr.message);
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/clients/:clientId/contacts/:id", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const existing = await storage.getClientContact(req.params.id);
      if (!existing || existing.clientId !== req.params.clientId) return res.status(404).json({ error: "Contact not found" });
      const actorUserId = req.user?.claims?.sub || req.user?.id || null;
      await storage.deleteClientContact(req.params.id, {
        actorUserId,
        source: "operator_ui",
        reason: `DELETE /api/clients/${req.params.clientId}/contacts/${req.params.id}`,
      });
      // Task #4329 — reap the deleted contact's segment-membership cache
      // rows inline (no FK on the polymorphic entity_id; sweep also heals).
      {
        const { pruneSegmentMembershipSafe } = await import("../services/tagSegmentEngine");
        await pruneSegmentMembershipSafe(req.params.id);
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // CLIENT AGENT MEMORY
  // ============================================

  app.get("/api/clients/:clientId/agent-memory", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const memory = await storage.getClientAgentMemory(req.params.clientId);
      res.json(memory);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/agent-memory", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { isProtectedInternalIdentifier } = await import("../services/companyIdentity");
      const { isBlockedSeedIdentifier } = await import("../services/seedingTrustPolicy");
      const identifierType = req.body.identifierType || "";
      const identifierValue = req.body.identifierValue || "";
      if (isProtectedInternalIdentifier(identifierType, identifierValue) || isBlockedSeedIdentifier(identifierType, identifierValue)) {
        return res.status(400).json({ error: "Cannot add blocked or internal company identifiers to client memory" });
      }
      const data = {
        ...req.body,
        clientId: req.params.clientId,
        source: "manual",
        manuallyAdded: true,
      };
      const memory = await storage.createClientAgentMemory(data);
      // Task #1574 — create-agent-memory returns 201 Created per REST conventions.
      res.status(201).json(memory);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/clients/:clientId/agent-memory/:id", isAuthenticated, requireAccountManager, async (req: ValidatedBodyRequest<Record<string, unknown>, { clientId: string; id: string }>, res) => {
    try {
      const parsedUpdate = updateAgentMemorySchema.safeParse(req.body ?? {});
      if (!parsedUpdate.success) {
        return res.status(400).json({ error: parsedUpdate.error.issues });
      }
      const updates = parsedUpdate.data;
      const { isProtectedInternalIdentifier } = await import("../services/companyIdentity");
      const { isBlockedSeedIdentifier } = await import("../services/seedingTrustPolicy");
      if (updates.identifierType && updates.identifierValue) {
        if (isProtectedInternalIdentifier(updates.identifierType, updates.identifierValue) || isBlockedSeedIdentifier(updates.identifierType, updates.identifierValue)) {
          return res.status(400).json({ error: "Cannot set blocked or internal company identifiers in client memory" });
        }
      }
      const allMemory = await storage.getClientAgentMemory(req.params.clientId);
      const existing = allMemory.find(m => m.id === req.params.id);
      if (!existing) return res.status(404).json({ error: "Memory entry not found" });
      const memory = await storage.updateClientAgentMemory(req.params.id, updates);
      res.json(memory);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/clients/:clientId/agent-memory/:id", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const allMemory = await storage.getClientAgentMemory(req.params.clientId);
      const existing = allMemory.find(m => m.id === req.params.id);
      if (!existing) return res.status(404).json({ error: "Memory entry not found" });
      await storage.deleteClientAgentMemory(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #2637: the agent-memory/seed route was removed — it seeded the
  // deleted agentMatchingEngine's per-client memory.

  app.post("/api/clients/:clientId/agent-memory/:id/promote", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const allMemory = await storage.getClientAgentMemory(req.params.clientId);
      const existing = allMemory.find(m => m.id === req.params.id);
      if (!existing) return res.status(404).json({ error: "Memory entry not found" });
      const memory = await storage.updateClientAgentMemory(req.params.id, {
        source: "manual",
        confidenceWeight: 1.0,
        manuallyAdded: true,
      });
      res.json(memory);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // AGENT MATCH DECISIONS & STATS
  // ============================================

  app.get("/api/clients/:clientId/agent-decisions", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const decisions = await storage.listAgentMatchDecisions({
        clientId: req.params.clientId,
        limit: Number(req.query.limit) || 50,
      });
      const enriched = await enrichDecisionsWithReviewerAndClient(decisions);
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/agent-stats", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const stats = await storage.getAgentMatchStats(req.params.clientId);
      const memory = await storage.getClientAgentMemory(req.params.clientId);
      res.json({
        ...stats,
        totalIdentifiers: memory.length,
        seededCount: memory.filter(m => m.source === "seeded").length,
        learnedCount: memory.filter(m => m.source === "learned").length,
        manualCount: memory.filter(m => m.source === "manual").length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agent-decisions", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const decisions = await storage.listAgentMatchDecisions({
        communicationId: req.query.communicationId as string,
        status: req.query.status as string,
        limit: Number(req.query.limit) || 50,
      });
      const enriched = await enrichDecisionsWithReviewerAndClient(decisions);
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agent-decisions/:id/correct", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { correctedToClientId } = req.body;
      if (!correctedToClientId) return res.status(400).json({ error: "correctedToClientId is required" });
      const decision = await storage.getAgentMatchDecision(req.params.id);
      if (!decision) return res.status(404).json({ error: "Decision not found" });

      if (correctedToClientId === decision.clientId) {
        return res.status(400).json({ error: "Corrected client must differ from original client" });
      }

      // Task #2637: the agent-learning side-effect (learnFromCorrection) was
      // removed. The deterministic correction of the decision row is kept.
      const updated = await storage.updateAgentMatchDecision(req.params.id, {
        correctedByHuman: true,
        reviewedByHuman: true,
        correctedToClientId,
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agent-decisions/:id/confirm", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const decision = await storage.getAgentMatchDecision(req.params.id);
      if (!decision) return res.status(404).json({ error: "Decision not found" });

      // Task #2637: the agent-learning side-effect (learnFromConfirmation) was
      // removed. The deterministic confirmation of the decision row is kept.
      const updated = await storage.updateAgentMatchDecision(req.params.id, {
        reviewedByHuman: true,
        correctedByHuman: false,
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // AGENT ENGINE OPERATIONS
  // ============================================

  // Task #2637: the agent-engine/seed-all route was removed — it seeded the
  // deleted agentMatchingEngine's memory across all clients.

  // Task #914: `/api/agent-engine/migrate-contacts` was removed along with
  // its underlying `migrateExistingContactsToTable` helper — the legacy
  // migration silently re-bloated contacts operators had cleaned up; any
  // future bulk contact promotion goes through
  // `clientContactPromotion.promoteEmailsToClientContact`. A 410-Gone
  // tombstone handler stood in its place from 2026-05-08 until Task #4087
  // deleted it after the D-DEAD wave-2 operator notice window closed with
  // zero prod hits (any stale bookmark now gets the SPA 404 instead of the
  // explanatory 410).

  // Task #2637: the agent-engine/evaluate route was removed — it ran the
  // deleted agentMatchingEngine's AI evaluation over a communication.

  app.post("/api/agent-engine/retroactive/:clientId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      // Task #1025: per-client ceiling enforced at the manual route too —
      // operator-initiated retroactive reprocesses get throttled when
      // the client already has the max number of pending jobs in queue.
      const { enqueueRetroactiveReprocessSafe } = await import(
        "../services/retroactiveReprocessControl"
      );
      const result = await enqueueRetroactiveReprocessSafe({
        clientId: req.params.clientId,
        source: "manual_route",
        workloadClass: "interactive_repair",
        payload: {
          channelType: req.body.channelType,
          maxItems: req.body.maxItems || 50,
        },
        maxAttempts: 2,
      });
      if (!result.enqueued) {
        return res.status(202).json({
          success: false,
          skipped: true,
          reason: result.reason,
          pendingCount: result.pendingCount,
          ceiling: result.ceiling,
          message: `Skipped: client already has ${result.pendingCount} pending retroactive_reprocess jobs (ceiling ${result.ceiling}).`,
        });
      }
      res.status(202).json({ success: true, jobId: result.jobId, message: "Retroactive reprocess job enqueued." });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // MEMORY RESET / REBUILD / CONTAMINATION
  // ============================================

  // Task #4087: the six agent-engine memory-reset/contamination routes
  // (memory-reset/dry-run|backup|execute/:clientId, release-claims/:clientId,
  // contamination-scan, release-and-rematch/:clientId) were removed after the
  // D-DEAD wave-2 operator notice window closed — zero callers anywhere, zero
  // prod invocations, zero 'Released%' side-effect rows all-time, and the
  // client_agent_memory table they operate on has been frozen since the
  // Task #2637 learning-engine removal. The memoryResetWorkflow service is
  // retained for the env-gated boot remediation
  // (server/boot/workersAndCleanup.ts, JONES_REMEDIATION_ENABLED) and for any
  // future emergency via a one-off maintenance script.

  // Task #3985: the agent-engine/remediate-jones route was removed after the
  // Track-D one-week operator notice window (2026-08-07 → 2026-08-14) closed.
  // The hardcoded client-name path had zero frontend/external callers. The
  // env-gated boot-time `remediateJones()` caller in
  // server/boot/workersAndCleanup.ts (JONES_REMEDIATION_ENABLED) is kept.

  // Task #2637: the agent-engine/decontaminate route was removed — it scrubbed
  // the deleted agentMatchingEngine's memory.

  // ============================================
  // PANDADOC INTEGRATION
  // ============================================

  // Task #4087: the standalone GET /api/integrations/pandadoc/status route was
  // removed after the D-DEAD wave-2 operator notice window closed — zero
  // callers and zero prod invocations; the Integrations Hub reads PandaDoc
  // status exclusively from the aggregate GET /api/integrations/all-status,
  // which embeds the same probe. connect/disconnect/sync/documents routes
  // remain live.

  app.post("/api/integrations/pandadoc/connect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "API key is required" });
      // Task #1977: mirror the Slack connect handler. Save the key, then
      // probe. Only a confirmed terminal PandaDoc auth rejection (401/403)
      // clears the freshly-saved key here; a transient 429/5xx/timeout
      // preserves it and returns 202 so a flaky PandaDoc response can't
      // wipe an admin-entered credential.
      const pandadocMod = await import("../services/pandadocIntegration");
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      await pandadocMod.setApiKey(apiKey, userId ?? undefined);
      const probe = await pandadocMod.probeConnection();
      await invalidateIntegrationStatus("pandadoc");

      if (probe.outcome === "connected") {
        return res.json({ ok: true });
      }
      if (probe.outcome === "unauthorized" && pandadocMod.isTerminalPandadocAuthReason(probe.reason)) {
        await pandadocMod.disconnect(userId ?? undefined, {
          trigger: "connect_terminal_auth_error",
          reason: probe.reason ?? null,
          notes: "Cleared by connect handler after PandaDoc returned a terminal auth status",
        });
        await invalidateIntegrationStatus("pandadoc");
        return res.status(400).json({
          error: `PandaDoc rejected the API key (${probe.reason}) — re-enter the key.`,
          reason: probe.reason,
        });
      }
      // probe_failed OR non-terminal unauthorized → key preserved.
      return res.status(202).json({
        ok: true,
        warning: `Key saved but verification failed (${probe.reason ?? "probe_failed"}). It will be probed again automatically; no action required unless it stays unhealthy.`,
        reason: probe.reason ?? "probe_failed",
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/integrations/pandadoc/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const pandadocMod = await import("../services/pandadocIntegration");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      await pandadocMod.disconnect(userId ?? undefined, { trigger: "manual_disconnect" });
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("pandadoc");
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // STRIPE INTEGRATION
  // ============================================

  app.post("/api/integrations/stripe/connect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "Stripe secret key is required" });
      const { connectStripe } = await import("../stripeClient");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      const result = await connectStripe(apiKey, userId ?? undefined);
      const { initializeStripeSync, resetStripeSyncInstance } = await import("../stripeSync");
      resetStripeSyncInstance();
      initializeStripeSync().catch((err: any) => console.error("[StripeSync] Post-connect init error:", err.message));
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("stripe");
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/integrations/stripe/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { disconnectStripe } = await import("../stripeClient");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      await disconnectStripe(userId ?? undefined);
      const { resetStripeSyncInstance } = await import("../stripeSync");
      resetStripeSyncInstance();
      const { invalidateIntegrationStatus } = await import("../services/integrationStatusCache");
      await invalidateIntegrationStatus("stripe");
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/pandadoc/sync", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const pandadocMod = await import("../services/pandadocIntegration");
      const result = await pandadocMod.syncDocuments();
      if (result.errors.length > 0) {
        console.error("[PandaDoc] Sync completed with errors:", result.errors);
        if (result.created === 0 && result.updated === 0) {
          res.status(502).json({
            error: `PandaDoc sync failed: ${result.errors[0]}`,
            partialResult: result,
          });
        } else {
          res.status(207).json(result);
        }
      } else {
        res.json(result);
      }
    } catch (error: any) {
      console.error("[PandaDoc] Sync route error:", error);
      res.status(500).json({
        error: `PandaDoc sync failed: ${error.message}`,
        partialResult: null,
      });
    }
  });

  app.get("/api/integrations/pandadoc/documents", isAuthenticated, async (req: any, res) => {
    try {
      const { search, clientId } = req.query;
      const docs = await storage.listPandadocDocuments({
        search: typeof search === "string" ? search : undefined,
        linkedClientId: typeof clientId === "string" ? clientId : undefined,
      });
      res.json(docs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/pandadoc/documents/:id", isAuthenticated, async (req: any, res) => {
    try {
      const doc = await storage.getPandadocDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const { buildDocumentAppUrl } = await import("../services/pandadocIntegration");
      res.json({ ...doc, pandadocAppUrl: doc.documentId ? buildDocumentAppUrl(doc.documentId) : null });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/pandadoc/documents/:id/pdf", isAuthenticated, async (req: any, res) => {
    try {
      const doc = await storage.getPandadocDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const pandadocMod = await import("../services/pandadocIntegration");
      const connected = await pandadocMod.isConnected();
      if (!connected) {
        return res.status(409).json({ error: "PandaDoc is not connected. Reconnect it from the Integrations page to download this document." });
      }
      try {
        const { buffer, contentType } = await pandadocMod.getDocumentPdfCached(doc.documentId, doc.lastSyncedAt);
        const safeTitle = (doc.title || "document").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "document";
        const filename = `${safeTitle}.pdf`;
        const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", String(buffer.length));
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
        res.setHeader("Cache-Control", "private, no-store");
        res.end(buffer);
      } catch (err: any) {
        if (err?.name === "PandadocDocumentNotReadyError") {
          return res.status(503).json({ error: err.message, retryable: true });
        }
        if (typeof err?.message === "string" && err.message.includes("Document not found in PandaDoc")) {
          return res.status(404).json({ error: "This document is no longer available in PandaDoc." });
        }
        if (typeof err?.message === "string" && err.message.includes("PandaDoc not connected")) {
          return res.status(409).json({ error: "PandaDoc is not connected. Reconnect it from the Integrations page to download this document." });
        }
        console.error("[PandaDoc] PDF download failed:", err);
        return res.status(502).json({ error: "Failed to download PDF from PandaDoc." });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/pandadoc/documents/:id/link", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.body;
      if (clientId) {
        const clientExists = await storage.getClient(clientId);
        if (!clientExists) return res.status(404).json({ error: "Client not found" });
      }
      const previous = await storage.getPandadocDocument(req.params.id);
      const doc = await storage.linkPandadocDocumentToClient(req.params.id, clientId || null);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (previous?.linkedClientId && !doc.linkedClientId && doc.documentId) {
        const pandadocMod = await import("../services/pandadocIntegration");
        pandadocMod.invalidatePdfCache(doc.documentId).catch((err: any) => {
          console.warn(`[PandaDoc] PDF cache invalidation on unlink failed: ${err?.message || err}`);
        });
      }
      res.json(doc);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/pandadoc-documents", isAuthenticated, async (req: any, res) => {
    try {
      const docs = await storage.getPandadocDocumentsByClient(req.params.clientId);
      res.json(docs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // CLIENT AGENT CHAT
  // ============================================

  app.get("/api/clients/:clientId/agent-chat", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const messages = await storage.getClientAgentChatMessages(req.params.clientId);
      res.json(messages);
    } catch (error: any) {
      console.error("Error fetching agent chat:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/clients/:clientId/agent-chat", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      await storage.deleteClientAgentChatMessages(req.params.clientId);
      res.status(204).send();
    } catch (error: any) {
      console.error("Error clearing agent chat:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/agent-chat", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { content } = req.body;
      const clientId = req.params.clientId;
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }

      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      // Task #3721: stamp the sender so the internal usage tracker can
      // count agent-chat usage per team member. Historical rows (and
      // assistant replies) stay unattributed by design.
      const senderUserId: string | null = req.user?.claims?.sub ?? null;
      await storage.createClientAgentChatMessage({
        clientId,
        role: "user",
        content,
        createdByUserId: senderUserId,
      });

      const { getClientContext, formatContextForPrompt } = await import("../services/contextRetrieval");

      const [
        commandPanel,
        intelEntries,
        actionEntries,
        comms,
        clientReports,
        agentMemory,
        knowledgeContext,
      ] = await Promise.all([
        storage.getCommandPanel(clientId),
        storage.listIntelligenceFeedEntries(clientId),
        storage.listActionLogEntries(clientId),
        storage.listRawCommunications(clientId),
        storage.getReportsByClient(clientId),
        storage.getClientAgentMemory(clientId),
        getClientContext(clientId, "agent_chat"),
      ]);

      const systemPromptParts: string[] = [
        `You are an AI assistant for the client "${client.firmName}". You have deep knowledge about this client and should answer questions using the context below. Be concise, specific, and reference concrete data points when possible.`,
        "",
        "=== CLIENT PROFILE ===",
        `Firm Name: ${client.firmName}`,
        client.contactName ? `Contact: ${client.contactName}` : "",
        client.contactEmail ? `Email: ${client.contactEmail}` : "",
        client.contactPhone ? `Phone: ${client.contactPhone}` : "",
        client.consultType ? `Consult Type: ${client.consultType}` : "",
        client.practiceAreas?.length ? `Practice Areas: ${client.practiceAreas.join(", ")}` : "",
        (commandPanel?.productTypes?.length || client.products?.length) ? `Products: ${(commandPanel?.productTypes || client.products || []).join(", ")}` : "",
        client.clientStartDate ? `Client Since: ${client.clientStartDate}` : "",
      ];

      if (commandPanel) {
        systemPromptParts.push(
          "",
          "=== COMMAND PANEL (STRATEGY) ===",
          commandPanel.quarterPrimaryObjective ? `Primary Objective: ${commandPanel.quarterPrimaryObjective}` : "",
          commandPanel.annualGoals ? `Annual Goals: ${commandPanel.annualGoals}` : "",
          commandPanel.longTermGoals ? `Long-Term Goals: ${commandPanel.longTermGoals}` : "",
          commandPanel.currentBottleneck ? `Current Bottleneck: ${commandPanel.currentBottleneck}` : "",
          commandPanel.budgetPosture ? `Budget Posture: ${commandPanel.budgetPosture}` : "",
          commandPanel.growthStrategy ? `Growth Strategy: ${commandPanel.growthStrategy}` : "",
          commandPanel.activeCampaignFocus ? `Active Campaign Focus: ${commandPanel.activeCampaignFocus}` : "",
          commandPanel.activeOffers ? `Active Offers: ${commandPanel.activeOffers}` : "",
          commandPanel.keyActiveInitiatives ? `Key Initiatives: ${commandPanel.keyActiveInitiatives}` : "",
          commandPanel.currentRiskFlags ? `Risk Flags: ${commandPanel.currentRiskFlags}` : "",
          commandPanel.currentOpportunities ? `Opportunities: ${commandPanel.currentOpportunities}` : "",
          commandPanel.clientPreferences ? `Client Preferences: ${commandPanel.clientPreferences}` : "",
          commandPanel.internalHandlingNotes ? `Internal Handling Notes: ${commandPanel.internalHandlingNotes}` : "",
        );
      }

      if (intelEntries.length > 0) {
        systemPromptParts.push("", "=== INTELLIGENCE FEED (last 20) ===");
        intelEntries.slice(0, 20).forEach((e) => {
          systemPromptParts.push(`- [${e.entryType}] ${e.title}${e.body ? ": " + e.body.slice(0, 200) : ""} (status: ${e.status})`);
        });
      }

      if (actionEntries.length > 0) {
        systemPromptParts.push("", "=== ACTION LOG (last 20) ===");
        actionEntries.slice(0, 20).forEach((e) => {
          systemPromptParts.push(`- [${e.actionType}] ${e.title}${e.whatChanged ? " — " + e.whatChanged.slice(0, 200) : ""}`);
        });
      }

      if (comms.length > 0) {
        systemPromptParts.push("", "=== RECENT COMMUNICATIONS (last 30) ===");
        comms.slice(0, 30).forEach((c) => {
          const summary = c.aiSummary || c.contentPreview || "";
          systemPromptParts.push(`- [${c.sourceType}] ${c.title} (${c.timestamp?.toISOString().split("T")[0] || "unknown date"})${summary ? ": " + summary.slice(0, 200) : ""}`);
        });
      }

      if (clientReports.length > 0) {
        systemPromptParts.push("", "=== REPORTS ===");
        clientReports.slice(0, 5).forEach((r) => {
          systemPromptParts.push(`- ${r.reportMonth} (status: ${r.status})`);
        });
      }

      if (agentMemory.length > 0) {
        systemPromptParts.push("", "=== AGENT MEMORY / IDENTIFIERS ===");
        agentMemory.slice(0, 30).forEach((m) => {
          systemPromptParts.push(`- ${m.identifierType}: ${m.identifierValue} (source: ${m.source}, weight: ${m.confidenceWeight})`);
        });
      }

      const knowledgeContextStr = formatContextForPrompt(knowledgeContext);
      if (knowledgeContextStr) {
        systemPromptParts.push("", knowledgeContextStr);
      }

      const systemPrompt = systemPromptParts.filter(Boolean).join("\n");

      const chatHistory = await storage.getClientAgentChatMessages(clientId);
      const recentHistory = chatHistory.slice(-40);
      const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: systemPrompt },
        ...recentHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: CHEAP_MODEL,
        messages: chatMessages,
        stream: true,
        reasoning_effort: "minimal",
        max_completion_tokens: 2048,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await storage.createClientAgentChatMessage({ clientId, role: "assistant", content: fullResponse });

      // fire-and-forget: background knowledge extraction, errors logged inside
      void (async () => {
        try {
          const { extractChatKnowledge } = await import("../services/agentKnowledgeService");
          await extractChatKnowledge(clientId, content, fullResponse);
        } catch (err: any) {
          console.error("[AgentChat] Knowledge extraction failed:", err.message);
        }
      })();

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      console.error("Error in agent chat:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Failed to get response" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // ============================================
  // DAILY JUDGMENT & ENRICHMENT API
  // ============================================

  app.get("/api/clients/:clientId/judgments", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const filters: any = {};
      if (req.query.dateFrom || req.query['date-from']) filters.dateFrom = new Date((req.query.dateFrom || req.query['date-from']) as string);
      if (req.query.dateTo || req.query['date-to']) filters.dateTo = new Date((req.query.dateTo || req.query['date-to']) as string);
      if (req.query.status) filters.status = req.query.status;
      if (req.query.hasUnresolvedAsks === "true" || req.query['has-unresolved-asks'] === "true") filters.hasUnresolvedAsks = true;
      if (req.query.negativeRelationship === "true" || req.query['negative-relationship'] === "true") filters.negativeRelationship = true;

      const judgments = await storage.listClientDailyJudgments(req.params.clientId, filters);
      res.json(judgments.map(withAccountRating));
    } catch (error) {
      console.error("Error fetching judgments:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/judgments/:judgmentId", isAuthenticated, async (req: any, res) => {
    try {
      const judgment = await storage.getClientDailyJudgment(req.params.judgmentId);
      if (!judgment || judgment.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Judgment not found" });
      }

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(withAccountRating(judgment));
    } catch (error) {
      console.error("Error fetching judgment:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // DAILY ACCOUNT JUDGMENT API (Task #68)
  // ============================================

  app.get("/api/clients/:clientId/daily-judgments", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const limit = parseInt(req.query.limit as string) || 30;
      const judgments = await storage.getClientDailyJudgments(clientId, limit);
      res.json(judgments.map(withAccountRating));
    } catch (error: any) {
      console.error("Error fetching daily judgments:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/daily-judgments/:judgmentId", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const judgment = await storage.getClientDailyJudgment(req.params.judgmentId);
      if (!judgment || judgment.clientId !== clientId) {
        return res.status(404).json({ error: "Judgment not found" });
      }
      res.json(withAccountRating(judgment));
    } catch (error: any) {
      console.error("Error fetching daily judgment:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/daily-judgments/generate", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const targetDate = req.body.date || new Date().toISOString().split("T")[0];

      // Task #3697 — no more binary zero-comms gate: generation itself judges
      // from whatever data exists and only refuses when NOTHING usable exists
      // (JudgmentSkippedError → 422 below).
      const { generateDailyJudgment } = await import("../services/dailyJudgment");

      const judgment = await generateDailyJudgment(clientId, targetDate);
      res.json(judgment);
    } catch (error: any) {
      if (error?.name === "JudgmentSkippedError") {
        return res.status(422).json({ error: `Cannot generate judgment: ${error.message}` });
      }
      console.error("Error generating daily judgment:", error);
      res.status(500).json({ error: error.message || "Failed to generate judgment" });
    }
  });

  app.get("/api/clients/:clientId/relationship-signals", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const limit = parseInt(req.query.limit as string) || 30;
      const signals = await storage.getClientRelationshipSignals(clientId, limit);
      res.json(signals);
    } catch (error: any) {
      console.error("Error fetching relationship signals:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/open-asks", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const filters: any = {};
      if (req.query.status) filters.status = req.query.status;
      if (req.query.askType || req.query['ask-type']) filters.askType = req.query.askType || req.query['ask-type'];

      const asks = await storage.listClientOpenAsks(req.params.clientId, filters);
      res.json(asks);
    } catch (error) {
      console.error("Error fetching open asks:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.patch("/api/clients/:clientId/open-asks/:askId", isAuthenticated, async (req: any, res) => {
    try {
      const ask = await storage.getClientOpenAsk(req.params.askId);
      if (!ask || ask.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Ask not found" });
      }

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });
      // Task #3694: the Churn Command Center "Promises & Asks" tab lets
      // directors resolve/dismiss ANY active client's ask through this
      // same endpoint. Directors may hold a legacy role outside the
      // account-manager ladder (ROLE_LEVELS maps unknown roles to 0) and
      // own none of the clients, so the churn-surface authority gate
      // (strict director+ in ALL permissive modes) is an explicit
      // additional grant here; everyone else keeps the original
      // ladder-or-owner requirement.
      if (
        !hasRole(user?.role, 'account_manager') &&
        client.ownerId !== userId &&
        !(await canAccessChurnCommandCenter(user))
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { status, resolutionNote } = req.body;
      if (!status || !["resolved", "dismissed", "open", "likely_open", "likely_resolved"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const updateData: any = { status };
      if (status === "resolved" || status === "dismissed") {
        updateData.resolvedAt = new Date();
        updateData.resolvedBy = userId;
      }
      if (resolutionNote) updateData.resolutionNote = resolutionNote;

      const updated = await storage.updateClientOpenAsk(req.params.askId, updateData);
      res.json(updated);
    } catch (error) {
      console.error("Error updating open ask:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/open-asks/cleanup-contaminated", isAuthenticated, async (req: any, res) => {
    try {
      const { clientId } = req.params;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager')) {
        return res.status(403).json({ error: "Access denied — account manager required" });
      }

      const dryRun = req.body.dryRun === true;

      const defaultPatterns = [
        "O'Brien", "OBrien",
        "Flanagan", "Grace Legal", "Abbott",
        "Okuosa", "Oscar Mendoza", "Punchwork",
        "Mendoza",
      ];
      const patterns: string[] = Array.isArray(req.body.patterns) && req.body.patterns.length > 0
        ? req.body.patterns
        : defaultPatterns;

      const allAsks = await storage.listClientOpenAsks(clientId);
      const activeAsks = allAsks.filter(a => a.status === "open" || a.status === "likely_open");

      const clientName = (client.firmName || "").toLowerCase();
      const matches: Array<{ id: string; summary: string; matchedPattern: string }> = [];

      for (const ask of activeAsks) {
        const text = ((ask.summary || "") + " " + (ask.askText || "") + " " + (ask.detail || "")).toLowerCase();
        const matchedPattern = patterns.find(pattern =>
          text.includes(pattern.toLowerCase()) && !clientName.includes(pattern.toLowerCase())
        );
        if (matchedPattern) {
          matches.push({ id: ask.id, summary: ask.summary, matchedPattern });
        }
      }

      if (!dryRun) {
        for (const match of matches) {
          await storage.updateClientOpenAsk(match.id, {
            status: "dismissed",
            resolutionNote: `Auto-dismissed: cross-client contamination (matched "${match.matchedPattern}")`,
            resolvedAt: new Date(),
            resolvedBy: userId,
          });
        }
      }

      res.json({
        dryRun,
        dismissed: matches.length,
        total: activeAsks.length,
        matches: matches.map(m => ({ id: m.id, summary: m.summary, matchedPattern: m.matchedPattern })),
      });
    } catch (error: any) {
      console.error("Error cleaning up contaminated asks:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/clients/:clientId/recent-comms-count", isAuthenticated, async (req: any, res) => {
    try {
      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!hasRole(user?.role, 'account_manager') && client.ownerId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const days = parseInt(req.query.days as string) || 30;
      const since = new Date();
      since.setDate(since.getDate() - days);
      const count = await storage.countClientCommunicationsInRange(req.params.clientId, since);
      res.json({ count, days });
    } catch (error) {
      console.error("Error fetching recent comms count:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/daily-judgments/run-all", isAuthenticated, requireCeo, (_req: any, res) => {
    try {
      res.json({ message: "Daily judgment generation started" });
      void startDailyJudgmentRun().catch(err => {
        console.error("[DailyJudgment] Manual cron run failed:", err.message);
      });
    } catch (error: any) {
      console.error("Error triggering daily judgment run:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/clients/:clientId/judgments/regenerate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || !hasRole(user.role, "account_manager")) {
        return res.status(403).json({ error: "Account manager access required to regenerate judgments" });
      }

      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      // Task #3697 — sparse-data clients regenerate fine now (operational
      // basis); only a client with literally no usable source is refused.
      const { generateDailyJudgment } = await import("../services/dailyJudgment");

      const judgment = await generateDailyJudgment(req.params.clientId);

      res.json(judgment);
    } catch (error: any) {
      if (error?.name === "JudgmentSkippedError") {
        return res.status(422).json({ error: `Cannot regenerate judgment: ${error.message}` });
      }
      console.error("Error regenerating judgment:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ============================================
  // AGENT KNOWLEDGE BASE API
  // ============================================

  app.get("/api/clients/:clientId/knowledge", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const clientId = req.params.clientId;
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const filters: any = {};
      if (req.query.category) filters.category = req.query.category;
      if (req.query.isActive !== undefined) filters.isActive = req.query.isActive === "true";

      const knowledge = await storage.getAgentKnowledgeByClient(clientId, filters);
      res.json(knowledge);
    } catch (error: any) {
      console.error("Error fetching knowledge base:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/clients/:clientId/knowledge", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const clientId = req.params.clientId;
      const validCategories = ["client_preference", "communication_pattern", "recurring_concern", "strategic_context", "relationship_insight", "behavioral_pattern"];
      const { factCategory, factText, confidence } = req.body;
      if (!factCategory || !factText) {
        return res.status(400).json({ error: "factCategory and factText are required" });
      }
      if (!validCategories.includes(factCategory)) {
        return res.status(400).json({ error: "Invalid factCategory" });
      }
      if (confidence !== undefined) {
        const conf = Number(confidence);
        if (isNaN(conf) || conf < 0 || conf > 1) {
          return res.status(400).json({ error: "confidence must be between 0 and 1" });
        }
      }
      const entry = await storage.createAgentKnowledgeEntry({
        clientId,
        factCategory,
        factText,
        confidence: confidence ?? 0.9,
        sourceAgent: "manual",
        sourceRecordId: null,
        usageCount: 1,
        isActive: true,
      });
      res.json(entry);
    } catch (error: any) {
      console.error("Error creating knowledge entry:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/clients/:clientId/knowledge/:id", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const existing = await storage.getAgentKnowledgeEntry(req.params.id);
      if (!existing || existing.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Knowledge entry not found" });
      }

      const validCategories = ["client_preference", "communication_pattern", "recurring_concern", "strategic_context", "relationship_insight", "behavioral_pattern"];
      const { factText, confidence, isActive, factCategory } = req.body;
      const updates: any = {};
      if (factText !== undefined) updates.factText = factText;
      if (confidence !== undefined) {
        const conf = Number(confidence);
        if (isNaN(conf) || conf < 0 || conf > 1) return res.status(400).json({ error: "confidence must be between 0 and 1" });
        updates.confidence = conf;
      }
      if (isActive !== undefined) updates.isActive = isActive;
      if (factCategory !== undefined) {
        if (!validCategories.includes(factCategory)) return res.status(400).json({ error: "Invalid factCategory" });
        updates.factCategory = factCategory;
      }

      const entry = await storage.updateAgentKnowledgeEntry(req.params.id, updates);
      if (!entry) return res.status(404).json({ error: "Knowledge entry not found" });
      res.json(entry);
    } catch (error: any) {
      console.error("Error updating knowledge entry:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/clients/:clientId/knowledge/:id", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const existing = await storage.getAgentKnowledgeEntry(req.params.id);
      if (!existing || existing.clientId !== req.params.clientId) {
        return res.status(404).json({ error: "Knowledge entry not found" });
      }
      await storage.deleteAgentKnowledgeEntry(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      console.error("Error deleting knowledge entry:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // AGENT FEEDBACK API
  // ============================================

  app.post("/api/agent-feedback", isAuthenticated, async (req: any, res) => {
    try {
      const { agentType, targetRecordId, targetRecordType, clientId, feedbackType, correctedValue } = req.body;
      if (!agentType || !targetRecordId || !targetRecordType || !feedbackType) {
        return res.status(400).json({ error: "agentType, targetRecordId, targetRecordType, and feedbackType are required" });
      }
      if (!["confirmed", "corrected", "dismissed"].includes(feedbackType)) {
        return res.status(400).json({ error: "feedbackType must be confirmed, corrected, or dismissed" });
      }

      let resolvedClientId = clientId || null;

      if (targetRecordType === "knowledge_base") {
        const entry = await storage.getAgentKnowledgeEntry(targetRecordId);
        if (!entry) return res.status(404).json({ error: "Knowledge entry not found" });
        resolvedClientId = entry.clientId;
      }

      if (resolvedClientId) {
        const userSub = req.user?.claims?.sub;
        if (!userSub) return res.status(401).json({ error: "Unauthorized" });
        const user = await storage.getUser(userSub);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const client = await storage.getClient(resolvedClientId);
        if (!client) return res.status(404).json({ error: "Client not found" });
        const role = user.role;
        if (role === 'sales') {
          return res.status(403).json({ error: "Sales role has read-only access" });
        } else if (role === 'account_manager' && client.ownerId !== user.id) {
          return res.status(403).json({ error: "Account managers can only access their own clients" });
        } else if (!hasRole(role, 'account_manager')) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
      }

      const userId = req.user?.claims?.sub;
      const feedback = await storage.createAgentFeedback({
        agentType,
        targetRecordId,
        targetRecordType,
        clientId: resolvedClientId,
        feedbackType,
        correctedValue: correctedValue || null,
        userId: userId || null,
      });

      try {
        if (targetRecordType === "knowledge_base") {
          const { boostKnowledgeConfidence, penalizeKnowledgeConfidence } = await import("../services/agentKnowledgeService");
          if (feedbackType === "confirmed") {
            await boostKnowledgeConfidence(targetRecordId);
          } else if (feedbackType === "corrected" || feedbackType === "dismissed") {
            await penalizeKnowledgeConfidence(targetRecordId);
          }
        } else if (resolvedClientId) {
          const { propagateFeedbackToKnowledge } = await import("../services/agentKnowledgeService");
          await propagateFeedbackToKnowledge(
            resolvedClientId,
            agentType,
            targetRecordId,
            feedbackType as "confirmed" | "corrected" | "dismissed",
          );
        }
      } catch (err: any) {
        console.error("[Feedback] Knowledge confidence update failed:", err.message);
      }

      res.json(feedback);
    } catch (error: any) {
      console.error("Error creating feedback:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/clients/:clientId/feedback", isAuthenticated, requireCommandCenterAccess, async (req: any, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const feedback = await storage.getAgentFeedbackByClient(req.params.clientId, limit);
      res.json(feedback);
    } catch (error: any) {
      console.error("Error fetching feedback:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/judgments/:judgmentId/feedback", isAuthenticated, async (req: any, res) => {
    try {
      const { feedbackType, correctedValue } = req.body;
      if (!feedbackType || !["confirmed", "corrected", "dismissed"].includes(feedbackType)) {
        return res.status(400).json({ error: "Valid feedbackType required" });
      }

      const judgment = await storage.getClientDailyJudgment(req.params.judgmentId);
      if (!judgment) return res.status(404).json({ error: "Judgment not found" });

      const userSub = req.user?.claims?.sub;
      if (!userSub) return res.status(401).json({ error: "Unauthorized" });
      const user = await storage.getUser(userSub);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const client = await storage.getClient(judgment.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });
      const role = user.role;
      if (role === 'sales') {
        return res.status(403).json({ error: "Sales role has read-only access" });
      } else if (role === 'account_manager' && client.ownerId !== user.id) {
        return res.status(403).json({ error: "Account managers can only access their own clients" });
      } else if (!hasRole(role, 'account_manager')) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const userId = req.user?.claims?.sub;
      const feedback = await storage.createAgentFeedback({
        agentType: "daily_judgment",
        targetRecordId: req.params.judgmentId,
        targetRecordType: "daily_judgment",
        clientId: judgment.clientId,
        feedbackType,
        correctedValue: correctedValue || null,
        userId: userId || null,
      });

      try {
        const { propagateFeedbackToKnowledge } = await import("../services/agentKnowledgeService");
        await propagateFeedbackToKnowledge(
          judgment.clientId,
          "daily_judgment",
          req.params.judgmentId,
          feedbackType as "confirmed" | "corrected" | "dismissed",
        );
      } catch (err: any) {
        console.error("[Feedback] Knowledge propagation failed:", err.message);
      }

      res.json(feedback);
    } catch (error: any) {
      console.error("Error recording judgment feedback:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/suggestions/:suggestionId/feedback", isAuthenticated, async (req: any, res) => {
    try {
      const { feedbackType, correctedValue } = req.body;
      if (!feedbackType || !["confirmed", "corrected", "dismissed"].includes(feedbackType)) {
        return res.status(400).json({ error: "Valid feedbackType required" });
      }

      const suggestion = await storage.getAiSuggestion(req.params.suggestionId);
      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      const resolvedClientId = suggestion.clientId;

      if (resolvedClientId) {
        const userSub = req.user?.claims?.sub;
        if (!userSub) return res.status(401).json({ error: "Unauthorized" });
        const user = await storage.getUser(userSub);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const client = await storage.getClient(resolvedClientId);
        if (!client) return res.status(404).json({ error: "Client not found" });
        const role = user.role;
        if (role === 'sales') {
          return res.status(403).json({ error: "Sales role has read-only access" });
        } else if (role === 'account_manager' && client.ownerId !== user.id) {
          return res.status(403).json({ error: "Account managers can only access their own clients" });
        } else if (!hasRole(role, 'account_manager')) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
      }

      const userId = req.user?.claims?.sub;
      const feedback = await storage.createAgentFeedback({
        agentType: "communication_analysis",
        targetRecordId: req.params.suggestionId,
        targetRecordType: "ai_suggestion",
        clientId: resolvedClientId,
        feedbackType,
        correctedValue: correctedValue || null,
        userId: userId || null,
      });

      if (resolvedClientId) {
        try {
          const { propagateFeedbackToKnowledge } = await import("../services/agentKnowledgeService");
          await propagateFeedbackToKnowledge(
            resolvedClientId,
            "communication_analysis",
            suggestion.rawCommunicationRecordId,
            feedbackType as "confirmed" | "corrected" | "dismissed",
          );
        } catch (err: any) {
          console.error("[Feedback] Knowledge propagation failed:", err.message);
        }
      }

      res.json(feedback);
    } catch (error: any) {
      console.error("Error recording suggestion feedback:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/threshold-policy", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { PERF } = await import("../perfConfig");
      const { getMatchSettingValue } = await import("../services/matchSettings");
      const sourceParam = typeof req.query.source === "string" ? req.query.source : undefined;
      const t = {
        exact: getMatchSettingValue("AGENT_THRESHOLD_EXACT", sourceParam),
        domain: getMatchSettingValue("AGENT_THRESHOLD_DOMAIN", sourceParam),
        heuristic: getMatchSettingValue("AGENT_THRESHOLD_HEURISTIC", sourceParam),
        semantic: getMatchSettingValue("AGENT_THRESHOLD_SEMANTIC", sourceParam),
        mixed: getMatchSettingValue("AGENT_THRESHOLD_MIXED", sourceParam),
      };
      res.json({
        scope: sourceParam || "default",
        evidenceAwareEnabled: PERF.AGENT_EVIDENCE_AWARE_ENABLED,
        flatThreshold: getMatchSettingValue("AGENT_CONFIDENCE_THRESHOLD", sourceParam),
        ambiguityGap: getMatchSettingValue("AGENT_AMBIGUITY_GAP", sourceParam),
        reviewFloor: getMatchSettingValue("AGENT_REVIEW_FLOOR", sourceParam),
        thresholds: {
          exact_deterministic: t.exact,
          unique_domain: t.domain,
          strong_heuristic: t.heuristic,
          semantic_dominant: t.semantic,
          mixed: t.mixed,
        },
        rationale: `Evidence-aware thresholding applies different confidence thresholds based on the type of evidence supporting a match. ` +
          `Exact identifiers (email, phone, Slack channel) use ${t.exact} — these are deterministic and low-risk. ` +
          `Domain-only matches use ${t.domain} — unique domains are strong signals when not public providers. ` +
          `Heuristic matches (keyword, alias, firm name) use ${t.heuristic} — name collisions are possible, requiring higher confidence. ` +
          `Semantic/AI-only matches use ${t.semantic} — AI judgments need stricter gating to prevent hallucination-driven claims. ` +
          `Mixed evidence (structured + semantic) uses ${t.mixed} — blended signals offer moderate reliability.`,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/zoom/review-queue", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const {
        listZoomReviewQueue,
        getZoomReviewReasonSummary,
        getZoomDismissReasonSummary,
        getZoomDismissReasonSummaryForRange,
        getZoomResolutionSummary,
        getZoomResolutionSummaryForRange,
        getZoomGuardrailThresholds,
        getZoomReviewSourceCounts,
      } = await import("../services/zoomReviewQueue");
      const includeResolved = String(req.query.includeResolved || "") === "true";
      const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;
      const windowDaysRaw = req.query.windowDays != null ? Number(req.query.windowDays) : NaN;
      const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
        ? Math.min(365, Math.floor(windowDaysRaw))
        : undefined;
      const sourceRaw = String(req.query.source || "all");
      const source: "all" | "backfill" | "live" =
        sourceRaw === "backfill" || sourceRaw === "live" ? sourceRaw : "all";
      const { dismissReasons: validDismissReasons } = await import("@shared/schema");
      const dismissReasonRaw = req.query.dismissReason
        ? String(req.query.dismissReason)
        : "";
      const dismissReason: string | undefined =
        dismissReasonRaw === "unspecified" ||
        (validDismissReasons as readonly string[]).includes(dismissReasonRaw)
          ? dismissReasonRaw
          : undefined;
      // #734: optional reviewResolution filter — approved / reassigned /
      // dismissed / reopened. Setting any of these implies includeResolved
      // inside listZoomReviewQueue.
      const reviewResolutionRaw = req.query.reviewResolution
        ? String(req.query.reviewResolution)
        : "";
      const reviewResolution:
        | "approved"
        | "reassigned"
        | "dismissed"
        | "reopened"
        | undefined =
        reviewResolutionRaw === "approved" ||
        reviewResolutionRaw === "reassigned" ||
        reviewResolutionRaw === "dismissed" ||
        reviewResolutionRaw === "reopened"
          ? reviewResolutionRaw
          : undefined;
      const priorRange = windowDays
        ? (() => {
            const now = Date.now();
            const winMs = windowDays * 24 * 60 * 60 * 1000;
            return {
              since: new Date(now - 2 * winMs),
              until: new Date(now - winMs),
            };
          })()
        : null;
      const previousDismissPromise: Promise<{ byReason: Record<string, number>; total: number } | null> =
        priorRange
          ? getZoomDismissReasonSummaryForRange(priorRange)
          : Promise.resolve(null);
      const previousResolutionPromise: Promise<
        { byResolution: import("../services/zoomReviewQueue").ZoomResolutionSummaryBuckets; total: number } | null
      > = priorRange
        ? getZoomResolutionSummaryForRange(priorRange)
        : Promise.resolve(null);
      const [
        items,
        reasonSummary,
        dismissSummary,
        sourceCounts,
        previousDismissSummary,
        resolutionSummary,
        previousResolutionSummary,
      ] = await Promise.all([
        listZoomReviewQueue({ includeResolved, limit, windowDays, source, dismissReason, reviewResolution }),
        getZoomReviewReasonSummary({ windowDays }),
        getZoomDismissReasonSummary({ windowDays }),
        getZoomReviewSourceCounts({ windowDays, includeResolved }),
        previousDismissPromise,
        getZoomResolutionSummary({ windowDays }),
        previousResolutionPromise,
      ]);
      res.json({
        items,
        reasonSummary,
        dismissSummary,
        previousDismissSummary,
        resolutionSummary,
        previousResolutionSummary,
        sourceCounts,
        source,
        thresholds: getZoomGuardrailThresholds(),
        windowDays: windowDays ?? null,
      });
    } catch (error: any) {
      console.error("[ZoomReview] list failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/zoom/guardrail-impact", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const {
        getZoomReviewReasonSummary,
        getZoomReviewReasonSummaryForRange,
        getZoomGuardrailKeyAnchors,
        getZoomReviewBucketsAroundAnchor,
        getZoomDismissReasonSummaryForRange,
      } = await import("../services/zoomReviewQueue");
      const windowDaysRaw = req.query.windowDays != null ? Number(req.query.windowDays) : NaN;
      const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
        ? Math.min(365, Math.floor(windowDaysRaw))
        : undefined;
      const reasonSummary = await getZoomReviewReasonSummary({ windowDays });
      let previousSummary: { byReason: Record<string, number>; total: number } | null = null;
      if (windowDays) {
        const now = Date.now();
        const winMs = windowDays * 24 * 60 * 60 * 1000;
        const currentSince = new Date(now - winMs);
        const previousSince = new Date(now - 2 * winMs);
        previousSummary = await getZoomReviewReasonSummaryForRange({
          since: previousSince,
          until: currentSince,
        });
      }

      // Per-key anchored before/after summaries. Each guardrail row gets a
      // delta vs. an equal-length window immediately before the last persisted
      // change to that key. Sample length = min(chosenWindow, time elapsed
      // since the change) so the two sides are always equal-length and
      // comparable. When `windowDays` is omitted ("all time") we fall back to
      // the full elapsed-since-anchor span vs. an equal-length pre-window.
      const matchSettingKeys = [
        "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
        "ZOOM_SHORT_TOKEN_MAX_LEN",
      ];
      const systemSettingKeys = ["ZOOM_COMMON_FIRST_NAMES"];
      const reasonsByKey: Record<string, string[]> = {
        ZOOM_STRONG_SIGNAL_MIN_WEIGHT: ["weak_signal_only", "solo_internal_participants"],
        ZOOM_SHORT_TOKEN_MAX_LEN: ["contact_name_only_weak"],
        ZOOM_COMMON_FIRST_NAMES: ["contact_name_only_weak"],
      };

      // Optional override: when the UI passes a `commonFirstNamesAnchorAuditId`,
      // we anchor the ZOOM_COMMON_FIRST_NAMES delta on that audit row's
      // `changedAt` instead of the system_settings.updatedAt (latest change).
      // This lets admins inspect before/after deltas around any historical
      // edit to the common first names list, not just the most recent one.
      const anchorOverrides: Record<string, Date> = {};
      const commonFirstNamesAnchorAuditId =
        typeof req.query.commonFirstNamesAnchorAuditId === "string"
          ? req.query.commonFirstNamesAnchorAuditId.trim()
          : "";
      if (commonFirstNamesAnchorAuditId) {
        const audit = await storage.getAdminSettingAuditById(commonFirstNamesAnchorAuditId);
        if (!audit || audit.settingKey !== "zoom_common_first_names") {
          return res.status(400).json({
            error: "commonFirstNamesAnchorAuditId does not refer to a known common-first-names audit row.",
          });
        }
        const changedAt = audit.changedAt instanceof Date
          ? audit.changedAt
          : audit.changedAt ? new Date(audit.changedAt as any) : null;
        if (!changedAt || !Number.isFinite(changedAt.getTime())) {
          return res.status(400).json({
            error: "Audit row is missing a valid changedAt timestamp.",
          });
        }
        anchorOverrides["ZOOM_COMMON_FIRST_NAMES"] = changedAt;
      }

      const anchors = await getZoomGuardrailKeyAnchors({
        matchSettingKeys,
        systemSettingKeys,
        anchorOverrides,
      });

      const now = Date.now();
      const requestedWindowMs = windowDays ? windowDays * 24 * 60 * 60 * 1000 : null;
      const allKeys = [...matchSettingKeys, ...systemSettingKeys];
      // Bucket count for the per-row sparkline (split evenly before/after the
      // anchor). 14 buckets ≈ daily granularity for the default 7d window and
      // is small enough to render inline next to the delta badge.
      const SPARKLINE_BUCKET_COUNT = 14;
      type BucketPoint = { start: string; end: string; count: number };
      const perKey: Record<
        string,
        {
          anchor: string | null;
          sampleMs: number;
          after: { byReason: Record<string, number>; total: number } | null;
          before: { byReason: Record<string, number>; total: number } | null;
          dismissAfter: { byReason: Record<string, number>; total: number } | null;
          dismissBefore: { byReason: Record<string, number>; total: number } | null;
          bucketCount: number;
          buckets: Record<string, BucketPoint[]>;
        }
      > = {};

      await Promise.all(
        allKeys.map(async (key) => {
          const anchor = anchors[key];
          if (!anchor) {
            perKey[key] = {
              anchor: null,
              sampleMs: 0,
              after: null,
              before: null,
              dismissAfter: null,
              dismissBefore: null,
              bucketCount: 0,
              buckets: {},
            };
            return;
          }
          const elapsedMs = Math.max(0, now - anchor.getTime());
          const sampleMs = requestedWindowMs
            ? Math.min(requestedWindowMs, elapsedMs)
            : elapsedMs;
          if (sampleMs <= 0) {
            perKey[key] = {
              anchor: anchor.toISOString(),
              sampleMs: 0,
              after: { byReason: {}, total: 0 },
              before: { byReason: {}, total: 0 },
              dismissAfter: { byReason: {}, total: 0 },
              dismissBefore: { byReason: {}, total: 0 },
              bucketCount: 0,
              buckets: {},
            };
            return;
          }
          const afterUntil = new Date(anchor.getTime() + sampleMs);
          const beforeSince = new Date(anchor.getTime() - sampleMs);
          const reasons = reasonsByKey[key] || [];
          const [after, before, dismissAfter, dismissBefore, ...bucketResults] = await Promise.all([
            getZoomReviewReasonSummaryForRange({ since: anchor, until: afterUntil }),
            getZoomReviewReasonSummaryForRange({ since: beforeSince, until: anchor }),
            getZoomDismissReasonSummaryForRange({ since: anchor, until: afterUntil }),
            getZoomDismissReasonSummaryForRange({ since: beforeSince, until: anchor }),
            ...reasons.map((reason) =>
              getZoomReviewBucketsAroundAnchor({
                anchor,
                windowMs: sampleMs,
                bucketCount: SPARKLINE_BUCKET_COUNT,
                reason,
              }),
            ),
          ]);
          const buckets: Record<string, BucketPoint[]> = {};
          let actualBucketCount = 0;
          reasons.forEach((reason, i) => {
            const result = bucketResults[i];
            if (result) {
              buckets[reason] = result.buckets;
              actualBucketCount = result.bucketCount;
            }
          });
          perKey[key] = {
            anchor: anchor.toISOString(),
            sampleMs,
            after,
            before,
            dismissAfter,
            dismissBefore,
            bucketCount: actualBucketCount,
            buckets,
          };
        }),
      );

      res.json({
        reasonSummary,
        previousSummary,
        windowDays: windowDays ?? null,
        perKey,
      });
    } catch (error: any) {
      console.error("[ZoomGuardrailImpact] failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get(
    "/api/admin/zoom/guardrail-change-history-trends",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const {
          getZoomReviewBucketsAroundAnchor,
          getZoomDismissReasonSummaryForRange,
        } = await import("../services/zoomReviewQueue");

        const settingKey = String(req.query.settingKey || "").trim();
        if (!settingKey) {
          return res.status(400).json({ error: "settingKey is required." });
        }
        // Mapping of supported settingKey → { source, reason } where:
        //   - source "admin_audit" reads from `admin_setting_audit` (e.g.
        //     the common-first-names override list, which is stored as a
        //     system setting and tracked via recordAdminSettingChange).
        //   - source "match_setting_history" reads from
        //     `agent_match_setting_history` (the four numeric Zoom guardrail
        //     keys edited via the match-settings PUT endpoint).
        //   - reason is the single review_reason filter applied to the
        //     routed-to-review sparkline. We pick the most directly affected
        //     reason per guardrail so the per-edit delta is meaningful (the
        //     `getZoomReviewBucketsAroundAnchor` helper accepts only one).
        // Catalog of supported (settingKey, sourceType) pairs. `sourceType`
        // is the `agent_match_decisions.source_type` we attribute the
        // routed-to-review / dismiss-reason impact to. Most entries target
        // "zoom" (existing behavior), but Task #1239 declares non-Zoom
        // entries — e.g. the common-first-names list affected
        // email/Slack/Twilio matching historically, so we
        // explicitly expose an `("zoom_common_first_names", "front_email")`
        // variant so operators can see how a list edit affected the email
        // matching path, not just Zoom.
        type TrendsConfig = {
          source: "admin_audit" | "match_setting_history";
          matchSettingScope?: string;
          reason: string | null;
          sourceType: string;
        };
        // Per-key map of supported configs, indexed by sourceType.
        // Directly keyed (no positional array indirection) so adding a new
        // (settingKey, sourceType) pair is a single inline edit.
        const TRENDS_BY_KEY: Record<string, Record<string, TrendsConfig>> = {
          zoom_common_first_names: {
            // legacy default: attribute impact to Zoom matching with the
            // zoom-specific review reason.
            zoom: {
              source: "admin_audit",
              reason: "contact_name_only_weak",
              sourceType: "zoom",
            },
            // Task #1239: non-Zoom variant — counts ALL routed-to-review
            // front_email decisions in the window (no reason filter) so the
            // Email Impact row in the names-history table can show how an
            // edit landed on the email matching path.
            front_email: {
              source: "admin_audit",
              reason: null,
              sourceType: "front_email",
            },
          },
          ZOOM_STRONG_SIGNAL_MIN_WEIGHT: {
            zoom: {
              source: "match_setting_history",
              matchSettingScope: "zoom",
              reason: "weak_signal_only",
              sourceType: "zoom",
            },
          },
          ZOOM_SHORT_TOKEN_MAX_LEN: {
            zoom: {
              source: "match_setting_history",
              matchSettingScope: "zoom",
              reason: "contact_name_only_weak",
              sourceType: "zoom",
            },
          },
          // Newly-supported numeric guardrails (Task #1239) — these don't
          // gate a specific Zoom auto-claim review_reason, so we count all
          // routed-to-review decisions (reason: null).
          ZOOM_TRANSCRIPT_CONTEXT_BUDGET: {
            zoom: {
              source: "match_setting_history",
              matchSettingScope: "zoom",
              reason: null,
              sourceType: "zoom",
            },
          },
          ZOOM_SHORTLIST_MAX: {
            zoom: {
              source: "match_setting_history",
              matchSettingScope: "zoom",
              reason: null,
              sourceType: "zoom",
            },
          },
        };
        const supportedConfigsForKey = TRENDS_BY_KEY[settingKey];
        if (!supportedConfigsForKey) {
          return res.status(400).json({
            error: `settingKey '${settingKey}' is not supported by this endpoint.`,
            supported: Object.keys(TRENDS_BY_KEY),
          });
        }
        // Allowed non-Zoom source types — keep in sync with the values
        // produced by the agent-matching engine for non-Zoom pipelines.
        const ALLOWED_SOURCE_TYPES = new Set<string>([
          "zoom",
          "front_email",
          "twilio_call",
          "twilio_sms",
          "slack",
        ]);
        const sourceTypeOverride = String(req.query.sourceType || "").trim();
        if (sourceTypeOverride && !ALLOWED_SOURCE_TYPES.has(sourceTypeOverride)) {
          return res.status(400).json({
            error: `sourceType '${sourceTypeOverride}' is not supported.`,
            supported: Array.from(ALLOWED_SOURCE_TYPES),
          });
        }
        const sourceType = sourceTypeOverride || "zoom";
        const config = supportedConfigsForKey[sourceType];
        if (!config) {
          return res.status(400).json({
            error: `sourceType '${sourceType}' is not declared for settingKey '${settingKey}'.`,
            supported: Object.keys(supportedConfigsForKey),
          });
        }
        // Reason filters (e.g. `weak_signal_only`) are written by the Zoom
        // auto-claim guardrails only — non-Zoom pipelines don't populate
        // `review_reason` in the same way. The configured `reason` is used
        // directly, but callers can still override via `?reason=`.
        const reasonOverride = req.query.reason;
        const reason =
          typeof reasonOverride === "string" && reasonOverride.length > 0
            ? reasonOverride
            : config.reason;

        const MIN_WINDOW_MS = 60 * 60 * 1000; // 1h
        const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90d
        const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d
        let windowMs = DEFAULT_WINDOW_MS;
        if (req.query.windowMs !== undefined && req.query.windowMs !== "") {
          const parsed = Number(req.query.windowMs);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return res.status(400).json({ error: "windowMs must be a positive finite number." });
          }
          windowMs = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.floor(parsed)));
        }

        const requestedBucketCount = Math.max(2, Math.min(48,
          Number.isFinite(Number(req.query.bucketCount)) && Number(req.query.bucketCount) > 0
            ? Math.floor(Number(req.query.bucketCount))
            : 16));
        // Mirror getZoomReviewBucketsAroundAnchor: round odd values up to the
        // next even number so the anchor lands on a bucket boundary. This
        // keeps the top-level `bucketCount` consistent with each row's
        // `routedToReview.bucketCount` for API consumers.
        const bucketCount = requestedBucketCount % 2 === 0
          ? requestedBucketCount
          : requestedBucketCount + 1;

        const limit = Math.max(1, Math.min(25,
          Number.isFinite(Number(req.query.limit)) && Number(req.query.limit) > 0
            ? Math.floor(Number(req.query.limit))
            : 10));

        type AuditLike = { id: string; changedAt: Date | string | null };
        const audits: AuditLike[] = config.source === "admin_audit"
          ? await storage.listAdminSettingAudit({ settingKey, limit })
          : await storage.listAgentMatchSettingHistory({
              source: config.matchSettingScope,
              settingKey,
              limit,
            });

        const rows = await Promise.all(
          audits.map(async (a) => {
            const changedAt = a.changedAt instanceof Date
              ? a.changedAt
              : a.changedAt ? new Date(a.changedAt as any) : null;
            if (!changedAt || !Number.isFinite(changedAt.getTime())) {
              return null;
            }
            const halfBefore = new Date(changedAt.getTime() - windowMs);
            const halfAfter = new Date(changedAt.getTime() + windowMs);
            const [routedToReview, dismissBefore, dismissAfter] = await Promise.all([
              getZoomReviewBucketsAroundAnchor({
                anchor: changedAt,
                windowMs,
                bucketCount,
                reason,
                sourceType,
              }),
              getZoomDismissReasonSummaryForRange({
                since: halfBefore,
                until: changedAt,
                sourceType,
              }),
              getZoomDismissReasonSummaryForRange({
                since: changedAt,
                until: halfAfter,
                sourceType,
              }),
            ]);
            return {
              auditId: a.id,
              changedAt: changedAt.toISOString(),
              routedToReview,
              dismissReasons: {
                before: dismissBefore,
                after: dismissAfter,
              },
            };
          }),
        );

        res.json({
          settingKey,
          sourceType,
          reason,
          windowMs,
          bucketCount,
          rows: rows.filter((r): r is NonNullable<typeof r> => r !== null),
        });
      } catch (error: any) {
        console.error("[ZoomGuardrailChangeHistoryTrends] failed:", error);
        res.status(500).json({ error: error?.message || "Failed to load guardrail-change history trends" });
      }
    },
  );

  app.get("/api/admin/zoom/review-queue/alert-settings", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const {
        getZoomReviewAlertSettings,
        getZoomReviewQueueMetrics,
      } = await import("../services/zoomReviewQueueAlerts");
      const [settings, metrics] = await Promise.all([
        getZoomReviewAlertSettings(),
        getZoomReviewQueueMetrics(),
      ]);
      res.json({
        settings,
        metrics: {
          pendingCount: metrics.pendingCount,
          oldestAgeHours: metrics.oldestAgeHours,
          oldestCreatedAt: metrics.oldestCreatedAt?.toISOString() || null,
        },
      });
    } catch (error: any) {
      console.error("[ZoomReviewAlert] get settings failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/admin/zoom/review-queue/alert-settings", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { updateZoomReviewAlertSettings } = await import("../services/zoomReviewQueueAlerts");
      const body = req.body || {};
      const settings = await updateZoomReviewAlertSettings({
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        countThreshold: body.countThreshold !== undefined ? Number(body.countThreshold) : undefined,
        ageHoursThreshold: body.ageHoursThreshold !== undefined ? Number(body.ageHoursThreshold) : undefined,
        cooldownMinutes: body.cooldownMinutes !== undefined ? Number(body.cooldownMinutes) : undefined,
        slackChannel: typeof body.slackChannel === "string" ? body.slackChannel : undefined,
        recipientEmails:
          body.recipientEmails !== undefined ? body.recipientEmails : undefined,
      });
      res.json({ settings });
    } catch (error: any) {
      console.error("[ZoomReviewAlert] update settings failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/review-queue/alert-settings/test", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const { runZoomReviewAlertCheck } = await import("../services/zoomReviewQueueAlerts");
      const forceCleared = req.body?.forceCleared === true;
      const forceBackedUp = req.body?.forceBackedUp === true;
      const status = await runZoomReviewAlertCheck({
        force: true,
        bypassCooldown: true,
        forceCleared,
        forceBackedUp,
      });
      res.json({ status });
    } catch (error: any) {
      console.error("[ZoomReviewAlert] test send failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task #996: at-a-glance backlog trend (now / 24h ago / 7d ago, plus
  // inflow / outflow over each window) for the Zoom Review Queue admin UI.
  // Task #3102: must be registered BEFORE the /:id route below — Express
  // matches in registration order, so the literal "trend" segment would
  // otherwise be swallowed by :id (the Sheets last-activity bug class).
  app.get("/api/admin/zoom/review-queue/trend", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const { getZoomReviewQueueTrend } = await import("../services/zoomReviewQueueAlerts");
      const trend = await getZoomReviewQueueTrend();
      res.json(trend);
    } catch (error: any) {
      console.error("[ZoomReview] trend failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/zoom/review-queue/:id", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { storage: stg } = await import("../storage");
      const decision = await stg.getAgentMatchDecision(req.params.id);
      if (!decision) return res.status(404).json({ error: "Decision not found" });
      const { findRawCommunicationByExternalSourceId } = await import("../storage/communicationStorage");
      let raw = await findRawCommunicationByExternalSourceId(decision.communicationId);
      if (!raw) raw = await stg.getRawCommunication(decision.communicationId);
      const suggestedClient = decision.clientId ? await stg.getClient(decision.clientId) : null;
      const priorClient = decision.priorClientId ? await stg.getClient(decision.priorClientId) : null;
      res.json({ decision, rawRecord: raw || null, suggestedClient, priorClient });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/review-queue/:id/approve", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { approveReviewDecision } = await import("../services/zoomReviewQueue");
      const userId = req.user?.claims?.sub || req.user?.id;
      const result = await approveReviewDecision({
        decisionId: req.params.id,
        userId,
        approvedClientId: req.body?.approvedClientId,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomReview] approve failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/review-queue/:id/dismiss", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { dismissReviewDecision } = await import("../services/zoomReviewQueue");
      const userId = req.user?.claims?.sub || req.user?.id;
      const result = await dismissReviewDecision({
        decisionId: req.params.id,
        userId,
        reason: req.body?.reason,
        reasonNote: req.body?.reasonNote,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomReview] dismiss failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  // Task #996: bulk dismiss multiple unresolved Zoom review rows in one call.
  // Loops the existing single-row helper so each row keeps its own DB
  // transaction and audit-trail stamp; returns succeeded/failed lists so the
  // UI can show partial success without rolling back already-dismissed rows.
  app.post("/api/admin/zoom/review-queue/bulk-dismiss", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { bulkDismissReviewDecisions } = await import("../services/zoomReviewQueue");
      const userId = req.user?.claims?.sub || req.user?.id;
      const ids = Array.isArray(req.body?.decisionIds) ? req.body.decisionIds : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "decisionIds is required and must be a non-empty array" });
      }
      if (ids.length > 200) {
        return res.status(400).json({ error: "Cannot bulk-dismiss more than 200 decisions in a single call" });
      }
      const result = await bulkDismissReviewDecisions({
        decisionIds: ids,
        userId,
        reason: req.body?.reason,
        reasonNote: req.body?.reasonNote,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomReview] bulk-dismiss failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  // Task #996: bulk approve / batch-assign multiple rows to a single client.
  // `approvedClientId` is optional — when omitted, each row is approved with
  // its existing suggested client (so this also works as a "approve everything
  // in this filter" action). Per-row rules from approveReviewDecision still
  // apply (e.g. no-candidate rows require approvedClientId).
  app.post("/api/admin/zoom/review-queue/bulk-approve", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { bulkApproveReviewDecisions } = await import("../services/zoomReviewQueue");
      const userId = req.user?.claims?.sub || req.user?.id;
      const ids = Array.isArray(req.body?.decisionIds) ? req.body.decisionIds : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "decisionIds is required and must be a non-empty array" });
      }
      if (ids.length > 200) {
        return res.status(400).json({ error: "Cannot bulk-approve more than 200 decisions in a single call" });
      }
      const approvedClientId = typeof req.body?.approvedClientId === "string" && req.body.approvedClientId.trim().length > 0
        ? req.body.approvedClientId.trim()
        : undefined;
      const result = await bulkApproveReviewDecisions({
        decisionIds: ids,
        userId,
        approvedClientId,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomReview] bulk-approve failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/review-queue/:id/reopen", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { reopenReviewDecision } = await import("../services/zoomReviewQueue");
      const userId = req.user?.claims?.sub || req.user?.id;
      const result = await reopenReviewDecision({
        decisionId: req.params.id,
        userId,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomReview] reopen failed:", error);
      res.status(400).json({ error: error.message });
    }
  });

  // ── Zoom Transcript Match Assistant (Task #4057) ─────────────────────────
  // Manual year-back sweep + AI match-guess review workbench. Additive tool:
  // assignment reuses the existing manual-reassign semantics and guesses are
  // never applied without the operator's explicit action.

  app.post("/api/admin/zoom/match-assistant/sweep", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { startZoomMatchSweep } = await import("../services/zoomTranscriptMatchAssistant");
      const userId = req.user?.claims?.sub || req.user?.id || null;
      const result = await startZoomMatchSweep({ startedByUserId: userId });
      if (!result.started) {
        return res.status(409).json({ error: result.message, reason: result.reason });
      }
      res.status(202).json({ started: true, sweepId: result.sweep.id });
    } catch (error: any) {
      console.error("[ZoomMatchAssistant] sweep start failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/zoom/match-assistant/sweep", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const { getZoomMatchSweepStatus } = await import("../services/zoomTranscriptMatchAssistant");
      const status = await getZoomMatchSweepStatus();
      res.json({ sweep: status });
    } catch (error: any) {
      console.error("[ZoomMatchAssistant] sweep status failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/zoom/match-assistant/calls", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { listZoomMatchWorkbenchCalls } = await import("../services/zoomTranscriptMatchAssistant");
      const pageRaw = Number(req.query.page);
      const limitRaw = Number(req.query.limit);
      const monthRaw = String(req.query.month || "");
      const result = await listZoomMatchWorkbenchCalls({
        page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1,
        limit: Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(100, Math.floor(limitRaw)) : 25,
        assigned: String(req.query.assigned || "all") === "unassigned" ? "unassigned" : "all",
        month: /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null,
        confidence: String(req.query.confidence || "all") === "low" ? "low" : "all",
        analyzed: String(req.query.analyzed || "all") === "analyzed" ? "analyzed" : "all",
      });
      res.json(result);
    } catch (error: any) {
      console.error("[ZoomMatchAssistant] calls list failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/match-assistant/calls/:id/assign", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { reassignZoomRecordToClient } = await import("../services/zoomManualReassign");
      const result = await reassignZoomRecordToClient(req.params.id, req.body?.clientId ?? null, req.user.claims.sub);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.json({ success: true, message: result.clientName
        ? `Meeting assigned to ${result.clientName}`
        : "Meeting set to unattributed" });
    } catch (error: any) {
      console.error("[ZoomMatchAssistant] assign failed:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/zoom/match-assistant/calls/:id/reanalyze", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { requestZoomMatchReanalysis } = await import("../services/zoomTranscriptMatchAssistant");
      const result = await requestZoomMatchReanalysis(req.params.id);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      res.status(202).json({ queued: true });
    } catch (error: any) {
      console.error("[ZoomMatchAssistant] reanalyze failed:", error);
      res.status(500).json({ error: error.message });
    }
  });
}
  
