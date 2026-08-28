/**
 * Onboarding intake routes (Task #5297) — stage 3 of the New Client
 * Onboarding epic.
 *
 * An internal, signed-in-staff-only surface: sales enters a new client's
 * basic info + private call notes and books immediately against the
 * onboarding pool (stage 2). There is no public/unauthenticated route here.
 * The client-side page is linked from the app nav via QuicklinksBar's
 * "Onboarding Call" entry (Task #5298, stage 4 of the epic).
 *
 * Auth model matches `POST /api/clients` exactly (any authenticated user;
 * non-account_manager+ self-assigns as owner) since this tool creates
 * clients under the same rules, just bundled with booking + an Intel entry.
 */
import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { writeLimiter } from "./middleware";
import {
  computeOnboardingAvailability,
  ONBOARDING_MEETING_DURATION_MINUTES,
} from "../services/onboardingBooking";
import { CalendarBusyUnavailableError, localDateKey, localTimeKey } from "../services/bookingAvailability";
import { runOnboardingIntake } from "../services/onboardingIntake";
import type { BookingPage } from "@shared/schema";
import { onboardingIntakeBodySchema } from "@shared/models/onboarding";

const slotsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  viewerTimezone: z.string().max(64).optional(),
});

export function registerOnboardingIntakeRoutes(app: Express): void {
  // Live combined availability across the onboarding pool — no clientId
  // exists yet, unlike the per-client slots route this mirrors the shape of.
  app.get("/api/onboarding/intake/slots", isAuthenticated, async (req: any, res) => {
    try {
      const parsed = slotsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      }
      const q = parsed.data;

      const fromUtc = q.from ? new Date(q.from) : new Date();
      const toUtc = q.to ? new Date(q.to) : new Date(fromUtc.getTime() + 14 * 24 * 60 * 60 * 1000);
      if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
        return res.status(400).json({ error: "Invalid from/to dates (must be ISO-8601)" });
      }
      // Cap at 90 days to bound query cost, mirroring the single-AM route.
      const cappedTo = new Date(Math.min(toUtc.getTime(), fromUtc.getTime() + 90 * 24 * 60 * 60 * 1000));

      let viewerTimezone = (q.viewerTimezone || "").trim();
      if (viewerTimezone) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: viewerTimezone });
        } catch {
          viewerTimezone = "";
        }
      }
      // No single "page" exists for a pool of people — local date/time
      // labels are purely a display grouping, keyed on the viewer's own
      // timezone (falling back to UTC) rather than any pool member's.
      const groupingPage = { timezone: viewerTimezone || "UTC" } as BookingPage;

      const result = await computeOnboardingAvailability({ fromUtc, toUtc: cappedTo });

      res.json({
        durationMinutes: ONBOARDING_MEETING_DURATION_MINUTES,
        viewerTimezone: viewerTimezone || null,
        poolSize: result.poolSize,
        slots: result.slots.map((s) => ({
          startUtc: s.startUtc.toISOString(),
          endUtc: s.endUtc.toISOString(),
          dateLocal: localDateKey(groupingPage, s.startUtc),
          timeLocal: localTimeKey(groupingPage, s.startUtc),
        })),
      });
    } catch (err: any) {
      if (err instanceof CalendarBusyUnavailableError) {
        console.warn("[OnboardingIntake] slots fail-closed (calendar unreachable):", err.message);
        return res.status(503).json({
          error: "Could not load onboarding availability right now. Please try again in a moment.",
          code: "calendar_unavailable",
          retriable: true,
        });
      }
      console.error("[OnboardingIntake] slots error:", err);
      res.status(500).json({ error: "Failed to load onboarding availability" });
    }
  });

  // The combined submit — create client, book against the pool, link the
  // meeting, log the notes as Intel. See `runOnboardingIntake` for the
  // partial-failure contract.
  app.post("/api/onboarding/intake", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = onboardingIntakeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const data = parsed.data;

      const startTimeUtc = new Date(data.startTimeUtc);
      if (startTimeUtc.getTime() <= Date.now()) {
        return res.status(400).json({ error: "The selected time has already passed. Pick another slot." });
      }

      const result = await runOnboardingIntake({
        rawClientBody: {
          firmName: data.firmName,
          contactName: data.contactName,
          contactEmail: data.contactEmail,
          contactPhone: data.contactPhone,
          consultType: data.consultType,
          products: data.products,
        },
        actingUserId: userId,
        actingUserRole: user.role,
        contactEmail: data.contactEmail,
        contactName: data.contactName,
        notes: data.notes,
        startTimeUtc,
        idempotencyKey: data.idempotencyKey,
        commandPanelSetup: {
          productTypes: data.products,
          googleAdsBudget: data.googleAdsBudget,
          lsaBudget: data.lsaBudget,
          webinarBudget: data.webinarBudget,
          gbpPlannedLocationCount: data.gbpPlannedLocationCount,
          gbpPlannedLocationCities: data.gbpPlannedLocationCities,
        },
      });

      if (!result.ok) {
        return res.status(result.status).json(result.body);
      }

      res.status(201).json({
        status: "confirmed",
        client: result.client,
        resolvedUserId: result.resolvedUserId,
        resolvedUser: result.resolvedUser,
        meeting: result.meeting,
        joinUrl: result.joinUrl,
        calendarEventUrl: result.calendarEventUrl,
        intelEntry: result.intelEntry,
        intelWarning: result.intelWarning,
      });
    } catch (err: any) {
      console.error("[OnboardingIntake] submit error:", err);
      res.status(500).json({ error: "Failed to complete onboarding intake" });
    }
  });
}
