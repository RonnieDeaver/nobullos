// @db-pool-intent: api
/**
 * Task #4336 — SMS consent ledger routes.
 *
 * Comms-facing (requireTwilioAccess — anyone who can see/send SMS can see
 * consent state, which the Conversation Hub and client pages surface):
 *   GET  /api/sms-consent/status?phone=…
 *   POST /api/sms-consent/status-batch          { phones: string[] ≤200 }
 *
 * Admin (requireTeamLead — ledger management and gate/alert settings):
 *   GET  /api/admin/sms-consent/ledger          ?state&search&limit&offset
 *   GET  /api/admin/sms-consent/events          ?phone&limit&offset
 *   GET  /api/admin/sms-consent/gate-audit      ?outcome&limit&offset
 *   GET  /api/admin/sms-consent/settings
 *   PUT  /api/admin/sms-consent/settings        { gate?, storm? }
 *   POST /api/admin/sms-consent/manual          { phone, state, note, timezone? }
 *
 * Every body/query is zod-parsed (no raw req.body spreads — house
 * persistence-write-boundary convention); validation failures return
 * 400 { error: issues }.
 */
import type { Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTwilioAccess, requireTeamLead } from "./middleware";
import { smsConsentStates, smsSendGateOutcomes } from "@shared/schema";

const statusQuerySchema = z.object({
  phone: z.string().trim().min(1).max(40),
});

const statusBatchSchema = z.object({
  phones: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
});

const ledgerQuerySchema = z.object({
  state: z.enum(smsConsentStates).optional(),
  search: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const eventsQuerySchema = z.object({
  phone: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const gateAuditQuerySchema = z.object({
  outcome: z.enum(smsSendGateOutcomes).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const settingsPutSchema = z.object({
  gate: z
    .object({
      automatedSendsEnabled: z.boolean(),
      sendWindowStartHourLocal: z.number().int().min(0).max(23),
      sendWindowEndHourLocal: z.number().int().min(0).max(23),
    })
    .optional(),
  storm: z
    .object({
      enabled: z.boolean(),
      windowMinutes: z.number().int().min(5).max(1440),
      threshold: z.number().int().min(1).max(1000),
      cooldownMinutes: z.number().int().min(0).max(10080),
    })
    .optional(),
});

const manualSetSchema = z.object({
  phone: z.string().trim().min(10).max(40),
  state: z.enum(smsConsentStates),
  note: z.string().trim().min(3).max(500),
  timezone: z.string().trim().max(60).nullable().optional(),
});

export function registerSmsConsentRoutes(app: Express): void {
  // ── Comms-facing status lookups ───────────────────────────────────────────

  app.get("/api/sms-consent/status", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    const parsed = statusQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    try {
      const { getConsentStatusForPhone } = await import("../services/smsConsent");
      res.json(await getConsentStatusForPhone(parsed.data.phone));
    } catch (err: any) {
      console.error("[SmsConsent] status lookup failed:", err?.message);
      res.status(500).json({ error: "Failed to load consent status" });
    }
  });

  app.post("/api/sms-consent/status-batch", isAuthenticated, requireTwilioAccess, async (req: any, res) => {
    const parsed = statusBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    try {
      const { getConsentStatusesForPhones } = await import("../services/smsConsent");
      res.json({ statuses: await getConsentStatusesForPhones(parsed.data.phones) });
    } catch (err: any) {
      console.error("[SmsConsent] batch status lookup failed:", err?.message);
      res.status(500).json({ error: "Failed to load consent statuses" });
    }
  });

  // ── Admin: ledger, events, gate audit ─────────────────────────────────────

  app.get("/api/admin/sms-consent/ledger", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const parsed = ledgerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    try {
      const storage = await import("../storage/smsConsentStorage");
      const [{ rows, total }, countsByState] = await Promise.all([
        storage.listConsentLedger({
          state: parsed.data.state,
          searchDigits: parsed.data.search,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        }),
        storage.countLedgerByState(),
      ]);
      res.json({ rows, total, countsByState });
    } catch (err: any) {
      console.error("[SmsConsent] ledger list failed:", err?.message);
      res.status(500).json({ error: "Failed to load consent ledger" });
    }
  });

  app.get("/api/admin/sms-consent/events", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    try {
      const storage = await import("../storage/smsConsentStorage");
      res.json({
        rows: await storage.listConsentEvents({
          phoneE164: parsed.data.phone,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        }),
      });
    } catch (err: any) {
      console.error("[SmsConsent] events list failed:", err?.message);
      res.status(500).json({ error: "Failed to load consent events" });
    }
  });

  app.get("/api/admin/sms-consent/gate-audit", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const parsed = gateAuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    try {
      const storage = await import("../storage/smsConsentStorage");
      res.json({
        rows: await storage.listSendGateAudit({
          outcome: parsed.data.outcome,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        }),
      });
    } catch (err: any) {
      console.error("[SmsConsent] gate-audit list failed:", err?.message);
      res.status(500).json({ error: "Failed to load send-gate audit" });
    }
  });

  // ── Admin: settings ───────────────────────────────────────────────────────

  app.get("/api/admin/sms-consent/settings", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const [{ getSmsSendGateConfig }, { getSmsOptOutStormAlertConfig }] = await Promise.all([
        import("../services/smsSendGate"),
        import("../services/smsOptOutStormAlerts"),
      ]);
      const [gate, storm] = await Promise.all([
        getSmsSendGateConfig(),
        getSmsOptOutStormAlertConfig(),
      ]);
      res.json({ gate, storm });
    } catch (err: any) {
      console.error("[SmsConsent] settings read failed:", err?.message);
      res.status(500).json({ error: "Failed to load SMS consent settings" });
    }
  });

  app.put("/api/admin/sms-consent/settings", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const parsed = settingsPutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    if (!parsed.data.gate && !parsed.data.storm) {
      return res.status(400).json({ error: "Provide `gate` and/or `storm` settings to update" });
    }
    try {
      const actorUserId: string | undefined = req.user?.claims?.sub;
      const { setSystemSetting } = await import("../storage/settingsStorage");
      if (parsed.data.gate) {
        const { SMS_SEND_GATE_CONFIG_KEY, smsSendGateConfigSchema } = await import(
          "../services/smsSendGate"
        );
        // Round-trip through the runtime schema so the stored JSON is
        // exactly what the gate will parse (defaults filled, no extras).
        const value = smsSendGateConfigSchema.parse(parsed.data.gate);
        await setSystemSetting(SMS_SEND_GATE_CONFIG_KEY, JSON.stringify(value), actorUserId);
      }
      if (parsed.data.storm) {
        const { SETTING_ENABLED, SETTING_WINDOW, SETTING_THRESHOLD, SETTING_COOLDOWN } =
          await import("../services/smsOptOutStormAlerts");
        const s = parsed.data.storm;
        await setSystemSetting(SETTING_ENABLED, String(s.enabled), actorUserId);
        await setSystemSetting(SETTING_WINDOW, String(s.windowMinutes), actorUserId);
        await setSystemSetting(SETTING_THRESHOLD, String(s.threshold), actorUserId);
        await setSystemSetting(SETTING_COOLDOWN, String(s.cooldownMinutes), actorUserId);
      }
      const [{ getSmsSendGateConfig }, { getSmsOptOutStormAlertConfig }] = await Promise.all([
        import("../services/smsSendGate"),
        import("../services/smsOptOutStormAlerts"),
      ]);
      res.json({
        gate: await getSmsSendGateConfig(),
        storm: await getSmsOptOutStormAlertConfig(),
      });
    } catch (err: any) {
      console.error("[SmsConsent] settings update failed:", err?.message);
      res.status(500).json({ error: "Failed to update SMS consent settings" });
    }
  });

  // ── Admin: manual state set ───────────────────────────────────────────────

  app.post("/api/admin/sms-consent/manual", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const parsed = manualSetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues });
    }
    const actorUserId: string | undefined = req.user?.claims?.sub;
    if (!actorUserId) {
      return res.status(401).json({ error: "No authenticated user" });
    }
    if (parsed.data.timezone) {
      const { isValidIanaTimezone } = await import("../services/smsQuietHours");
      if (!isValidIanaTimezone(parsed.data.timezone)) {
        return res.status(400).json({ error: `Unknown IANA timezone: ${parsed.data.timezone}` });
      }
    }
    try {
      const { setConsentManually } = await import("../services/smsConsent");
      const result = await setConsentManually({
        phone: parsed.data.phone,
        state: parsed.data.state,
        note: parsed.data.note,
        actorUserId,
        timezone: parsed.data.timezone,
      });
      if ("error" in result) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[SmsConsent] manual set failed:", err?.message);
      res.status(500).json({ error: "Failed to update consent state" });
    }
  });
}
