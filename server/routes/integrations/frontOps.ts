/**
 * Integrations routes — historical backfill.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 5082–5385, 5416–5485); sections: historical backfill; unmatched diagnosis; attach sender(s) to client; hard-match tile (match-stats, audit, backfill-867).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import type { AuthenticatedRequest } from "../requestContext";
import {
  clients,
} from "@shared/schema";

export function registerIntegrationsFrontOpsRoutes(app: Express) {
  app.post("/api/integrations/front/historical-backfill", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const confirmInternal = req.body?.confirmInternal === true;
      if (!confirmInternal) {
        return res.status(410).json({
          error: "deprecated",
          message: "Legacy historical-backfill is deprecated. Use POST /api/integrations/front/historical-recovery/execute with customWindows for date-range recovery. To run this legacy queue-job anyway, pass { confirmInternal: true }.",
          canonicalEndpoint: "/api/integrations/front/historical-recovery/execute",
        });
      }
      console.warn(`[Integrations] DEPRECATED legacy historical-backfill invoked by user ${req.user?.id ?? "?"}`);
      const { startDate, endDate } = req.body || {};
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required (ISO 8601 format)" });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: "startDate and endDate must be valid dates" });
      }
      if (start >= end) {
        return res.status(400).json({ error: "startDate must be before endDate" });
      }

      const startEpoch = Math.floor(start.getTime() / 1000);
      const endEpoch = Math.floor(end.getTime() / 1000);
      const runId = `backfill_${startEpoch}_${endEpoch}`;

      const { submitRepairJob } = await import("../../services/workQueueHandlers");
      const jobId = await submitRepairJob({
        queueName: "front_historical_backfill",
        workloadClass: "maintenance",
        payload: { startDate, endDate, runId },
        priority: 300,
        maxAttempts: 5,
        dedupeKey: `front_historical_backfill:${runId}`,
      });

      return res.status(202).json({
        success: true,
        jobId,
        runId,
        message: `Historical backfill job enqueued for ${startDate} to ${endDate}.`,
      });
    } catch (error: any) {
      console.error("[Integrations] Front historical backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/historical-backfill/status/:runId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getFrontBackfillStatus } = await import("../../services/frontWebhookIngestion");
      const status = await getFrontBackfillStatus(req.params.runId);
      if (!status) {
        return res.status(404).json({ error: "Backfill run not found" });
      }
      return res.json(status);
    } catch (error: any) {
      console.error("[Integrations] Front backfill status error:", error);
      res.status(500).json({ error: error.message });
    }
  });


  // Task #2512 — diagnose WHY the Front backlog is unmatched, by cause.
  // Read-only: classifies every unmatched front_sync_emails row against the
  // same deterministic hard-match resolver the live pipeline uses, and ranks
  // the actionable gaps (external domains no client owns yet). Powers the
  // Pipeline Health "Raise match rate" card so an operator can see the
  // breakdown and act on the high-volume domains.
  app.get("/api/integrations/front/unmatched-diagnosis", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const topDomainsRaw = Number.parseInt(String(req.query.topDomains ?? "25"), 10);
      const topDomains = Number.isFinite(topDomainsRaw) && topDomainsRaw > 0 ? topDomainsRaw : 25;
      const { diagnoseUnmatchedBacklog } = await import("../../services/frontUnmatchedDiagnosis");
      const diagnosis = await diagnoseUnmatchedBacklog({ topDomains });
      res.set("Cache-Control", "no-store");
      return res.json(diagnosis);
    } catch (error: any) {
      console.error("[Integrations] unmatched-diagnosis error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task #2512 — close a client-data gap: attach a sender email or domain to
  // a client, then deterministically re-evaluate ONLY the unmatched rows that
  // sender/domain touches. Precision is preserved — public free-mail and
  // company domains are rejected, spam senders are filtered — and the match
  // stays hard-match-only. Returns the matched lift so the UI can show
  // before/after.
  app.post("/api/integrations/front/attach-sender-to-client", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { clientId?: string; email?: string; domain?: string };
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase().replace(/^@/, "") : "";

      if (!clientId) {
        return res.status(400).json({ error: "clientId is required" });
      }
      if (!email && !domain) {
        return res.status(400).json({ error: "Provide an email or a domain to attach" });
      }
      if (email && domain) {
        return res.status(400).json({ error: "Provide either an email or a domain, not both" });
      }

      const { storage } = await import("../../storage");
      const client = await storage.getClient(clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const {
        isPublicEmailDomain, isCompanyDomain, isCompanyEmail, extractDomain,
      } = await import("../../services/companyIdentity");
      const { isVendorPlatformDomain } = await import("../../services/seedingTrustPolicy");
      const { isSpamSenderEmail, reEvaluateUnmatchedForTarget } = await import("../../services/frontIntegration");
      const { invalidateHardMatchIndexes } = await import("../../services/frontHardMatch");

      let attached: { kind: "email" | "domain"; value: string } | null = null;

      if (domain) {
        // Guardrails: a trusted domain must be a private, client-owned domain.
        if (!domain.includes(".") || domain.includes("@") || domain.includes(" ")) {
          return res.status(400).json({ error: `"${domain}" is not a valid domain` });
        }
        if (isPublicEmailDomain(domain)) {
          return res.status(400).json({ error: `"${domain}" is a public free-mail domain and cannot be trusted to a single client` });
        }
        if (isCompanyDomain(domain)) {
          return res.status(400).json({ error: `"${domain}" is an internal company domain and cannot be attached to a client` });
        }
        // Task #4790: vendor platforms (Stripe, Replit, Tabs3, CallRail, …)
        // send NoBull's own operational/receipt mail — trusting one to a
        // client auto-matches vendor noise into their comm log.
        if (isVendorPlatformDomain(domain)) {
          return res.status(400).json({ error: `"${domain}" is a vendor platform domain (payment/software vendors mail everyone) and cannot be trusted to a single client` });
        }
        const { normalizeClientEmailDomains } = await import("@shared/models/clients");
        const existing = normalizeClientEmailDomains(client.emailDomains as unknown);
        if (!existing.includes(domain)) {
          const updated = await storage.updateClient(clientId, {
            emailDomains: normalizeClientEmailDomains([...existing, domain]),
          });
          if (!updated) {
            return res.status(500).json({ error: "Failed to update client domains" });
          }
        }
        attached = { kind: "domain", value: domain };
      } else {
        // Exact-email attach: company / vendor / spam addresses are never
        // valid contacts.
        if (!email.includes("@")) {
          return res.status(400).json({ error: `"${email}" is not a valid email` });
        }
        if (isCompanyEmail(email)) {
          return res.status(400).json({ error: `"${email}" is an internal company address and cannot be attached to a client` });
        }
        // Task #4790: an address ON a vendor-platform domain (e.g.
        // `contact@mail.replit.com`, `receipts+…@stripe.com`) is vendor mail,
        // not client identity — refused outright, like public/internal.
        {
          const emailDomain = extractDomain(email);
          if (emailDomain && isVendorPlatformDomain(emailDomain)) {
            return res.status(400).json({ error: `"${email}" is a vendor platform address (${emailDomain}) and cannot be a client contact` });
          }
        }
        if (isSpamSenderEmail(email)) {
          return res.status(400).json({ error: `"${email}" looks like an automated/spam sender and cannot be a client contact` });
        }
        const { promoteEmailsToClientContact } = await import("../../services/clientContactPromotion");
        const promo = await promoteEmailsToClientContact({
          clientId,
          emails: [email],
          userId: req.user?.claims?.sub,
          explicitOptIn: true,
          auditSource: "front_unmatched_attach",
        });
        if (promo.added === 0 && promo.reason && promo.reason !== "already_present") {
          return res.status(400).json({ error: `Could not attach email: ${promo.reason}` });
        }
        attached = { kind: "email", value: email };
      }

      // The client-data write changed the matcher's input — drop the cached
      // indexes so the targeted re-eval sees it.
      invalidateHardMatchIndexes();

      const reeval = await reEvaluateUnmatchedForTarget(
        attached.kind === "domain" ? { domain: attached.value } : { email: attached.value },
      );

      res.set("Cache-Control", "no-store");
      return res.json({
        attached,
        clientId,
        firmName: client.firmName,
        reEvaluated: reeval.total,
        matched: reeval.matched,
        filterRuleHandled: reeval.filterRuleHandled,
      });
    } catch (error: any) {
      console.error("[Integrations] attach-sender-to-client error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task #2526 — batch counterpart to attach-sender-to-client: attach SEVERAL
  // sender domains to a SINGLE client in one action, then run one combined
  // re-evaluation that reports the total matched lift. Each domain still runs
  // the identical public / company / spam guardrails server-side, so the batch
  // path can never weaken precision relative to the one-at-a-time flow.
  app.post("/api/integrations/front/attach-senders-to-client", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { clientId?: string; domains?: unknown };
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      if (!clientId) {
        return res.status(400).json({ error: "clientId is required" });
      }

      const rawDomains = Array.isArray(body.domains) ? body.domains : [];
      // Normalize, lower-case, strip a leading @, drop blanks, de-duplicate.
      const domains = Array.from(
        new Set(
          rawDomains
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
            .filter((d) => d.length > 0),
        ),
      );
      if (domains.length === 0) {
        return res.status(400).json({ error: "Provide at least one domain to attach" });
      }
      if (domains.length > 100) {
        return res.status(400).json({ error: "Too many domains in one batch (max 100)" });
      }

      const { storage } = await import("../../storage");
      const client = await storage.getClient(clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const { isPublicEmailDomain, isCompanyDomain } = await import("../../services/companyIdentity");
      const { isVendorPlatformDomain } = await import("../../services/seedingTrustPolicy");
      const { reEvaluateUnmatchedForTargets } = await import("../../services/frontIntegration");
      const { invalidateHardMatchIndexes } = await import("../../services/frontHardMatch");
      const { normalizeClientEmailDomains } = await import("@shared/models/clients");

      const existing = normalizeClientEmailDomains(client.emailDomains as unknown);
      const existingSet = new Set(existing);

      type DomainResult = { domain: string; status: "attached" | "already" | "skipped"; reason?: string };
      const results: DomainResult[] = [];
      const toAdd: string[] = [];
      // Domains we will feed into the combined re-eval — every domain that ends
      // up trusted to the client (newly added OR already present), so the
      // operator sees the full lift across the selected set.
      const reEvalDomains: string[] = [];

      for (const domain of domains) {
        if (!domain.includes(".") || domain.includes("@") || domain.includes(" ")) {
          results.push({ domain, status: "skipped", reason: "not a valid domain" });
          continue;
        }
        if (isPublicEmailDomain(domain)) {
          results.push({ domain, status: "skipped", reason: "public free-mail domain — cannot be trusted to a single client" });
          continue;
        }
        if (isCompanyDomain(domain)) {
          results.push({ domain, status: "skipped", reason: "internal company domain — cannot be attached to a client" });
          continue;
        }
        // Task #4790: vendor platforms mail everyone — never client identity.
        if (isVendorPlatformDomain(domain)) {
          results.push({ domain, status: "skipped", reason: "vendor platform domain — payment/software vendor mail can never identify a client" });
          continue;
        }
        if (existingSet.has(domain)) {
          results.push({ domain, status: "already" });
          reEvalDomains.push(domain);
          continue;
        }
        toAdd.push(domain);
        existingSet.add(domain);
        results.push({ domain, status: "attached" });
        reEvalDomains.push(domain);
      }

      if (toAdd.length > 0) {
        const updated = await storage.updateClient(clientId, {
          emailDomains: normalizeClientEmailDomains([...existing, ...toAdd]),
        });
        if (!updated) {
          return res.status(500).json({ error: "Failed to update client domains" });
        }
      }

      // The client-data write changed the matcher's input — drop the cached
      // indexes so the combined re-eval sees the freshly-added domains.
      invalidateHardMatchIndexes();

      const reeval = reEvalDomains.length > 0
        ? await reEvaluateUnmatchedForTargets(reEvalDomains.map((domain) => ({ domain })))
        : { total: 0, matched: 0, filterRuleHandled: 0 };

      res.set("Cache-Control", "no-store");
      return res.json({
        clientId,
        firmName: client.firmName,
        results,
        attached: toAdd.length,
        alreadyPresent: results.filter((r) => r.status === "already").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        reEvaluated: reeval.total,
        matched: reeval.matched,
        filterRuleHandled: reeval.filterRuleHandled,
      });
    } catch (error: any) {
      console.error("[Integrations] attach-senders-to-client error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // Task #867 — hard-match dashboard tile + audit log + AI suggestions.
  // ============================================

  // Dashboard tile: aggregate counts by match_status and match_method so
  // the Front Integration page can show "X auto-matched (email_exact: A,
  // email_domain: B), Y unmatched, Z dismissed".
  app.get("/api/integrations/front/match-stats", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      // Task #2633 — message grain. matched / unmatched / matchable / matchRate
      // come from the SAME canonical helper the KPI strip and Messages tab use,
      // and `byMethod` counts matched MESSAGES per match method so the
      // "Matched by method" rows sum to the message-grain Matched figure.
      const { getFrontMessageGrainStats, getFrontMessageGrainMatchMethods } = await import(
        "../../services/frontMessageGrainStats"
      );
      const [grain, byMethod] = await Promise.all([
        getFrontMessageGrainStats(db),
        getFrontMessageGrainMatchMethods(db),
      ]);
      res.set("Cache-Control", "no-store");
      res.json({
        total: grain.total,
        matched: grain.matched,
        unmatched: grain.unmatched,
        matchable: grain.matchable,
        matchRate: grain.matchRate,
        byMethod,
      });
    } catch (error: any) {
      console.error("[Integrations] Front match-stats error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Audit trail for a single Front sync email — "why did this email move
  // (or not move)?". Returns the most recent audit rows in reverse
  // chronological order.
  app.get("/api/integrations/front/audit/:syncEmailId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const rows = await storage.listFrontMatchAuditLog({
        syncEmailId: req.params.syncEmailId,
        limit: 100,
      });
      res.set("Cache-Control", "no-store");
      res.json({ items: rows });
    } catch (error: any) {
      console.error("[Integrations] Front audit lookup error:", error);
      res.status(500).json({ error: error.message });
    }
  });


  // One-time (idempotent) backfill: walk every front_sync_email, run the
  // hard matcher, and write an audit row capturing the prior + new state.
  // Returns aggregate counters; safe to re-run.
  app.post("/api/integrations/front/backfill-867", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { runFrontHardMatchBackfill867 } = await import("../../services/frontIntegration");
      const result = await runFrontHardMatchBackfill867({
        dryRun: req.body?.dryRun === true,
        maxItems: typeof req.body?.maxItems === "number" ? req.body.maxItems : undefined,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[Integrations] Front #867 backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

}
