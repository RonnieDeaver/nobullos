import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole } from "./middleware";
import { isStripeConfiguredAsync, getStripeConfigurationStatus, getCustomerBillingSummary, searchStripeCustomers } from "../stripeClient";
import { processStripeWebhook } from "../stripeSync";

async function authorizeClientBillingAccess(req: any, res: any): Promise<{ user: any; client: any } | null> {
  const userId = req.user?.claims?.sub;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const user = await storage.getUser(userId);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const client = await storage.getClient(req.params.clientId);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return null;
  }

  if (hasRole(user.role, "account_manager")) {
    return { user, client };
  }

  res.status(403).json({ error: "You do not have access to this client's billing data" });
  return null;
}

const stripeLinkSchema = z.object({
  stripeCustomerId: z.string().regex(/^cus_[a-zA-Z0-9]+$/).nullable(),
});

export function registerBillingRoutes(app: Express) {
  app.get("/api/stripe/status", isAuthenticated, async (_req: any, res) => {
    // Task #2811 — `isStripeConfiguredAsync()` folds "settings read THREW
    // with no last-good" into `false`, so a DB blip answered
    // `configured: false` here. Use the three-state resolver: only a
    // confirmed-empty read may say not-configured; an unknown read is an
    // explicit status-unknown 503 (mirrors the Google Ads route, Task #2807).
    const resolution = await getStripeConfigurationStatus();
    if (resolution.status === "unknown") {
      console.error("[Stripe] /status key lookup failed:", resolution.error);
      return res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        configured: null,
        reason: String(resolution.error).slice(0, 200),
      });
    }
    res.json({ configured: resolution.status === "found" });
  });

  app.get("/api/clients/:clientId/billing", isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientBillingAccess(req, res);
      if (!auth) return;

      const { client } = auth;

      if (!(await isStripeConfiguredAsync())) {
        return res.json({ configured: false, linked: false, billing: null });
      }

      if (!client.stripeCustomerId) {
        return res.json({ configured: true, linked: false, billing: null });
      }

      const billing = await getCustomerBillingSummary(client.stripeCustomerId);
      if (!billing) {
        // Task #1574 — previously returned 200 with an embedded `error`
        // field, which violates the project error-envelope standard and
        // hides upstream Stripe failures from the global query-client
        // toast. 502 is the right code here because we successfully
        // reached Stripe and got an unusable / empty response back.
        return res.status(502).json({
          configured: true,
          linked: true,
          billing: null,
          error: "Failed to fetch billing data from Stripe",
        });
      }

      res.json({ configured: true, linked: true, billing });
    } catch (error: any) {
      console.error("[Billing] Error:", error.message);
      res.status(500).json({ error: "Failed to fetch billing data" });
    }
  });

  app.patch("/api/clients/:clientId/stripe-link", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      if (!hasRole(user.role, "account_manager")) {
        return res.status(403).json({ error: "Account manager access required to link Stripe customers" });
      }

      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const parsed = stripeLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid Stripe customer ID format", details: parsed.error.issues });
      }

      const updated = await storage.updateClient(req.params.clientId, {
        stripeCustomerId: parsed.data.stripeCustomerId,
      });

      res.json(updated);
    } catch (error: any) {
      console.error("[Billing] Error linking Stripe customer:", error.message);
      res.status(500).json({ error: "Failed to link Stripe customer" });
    }
  });

  app.get("/api/stripe/customers/search", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await storage.getUser(userId);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      if (!hasRole(user.role, "account_manager")) {
        return res.status(403).json({ error: "Account manager access required to search Stripe customers" });
      }

      if (!(await isStripeConfiguredAsync())) {
        return res.json({ customers: [] });
      }

      const query = (req.query.q as string) || "";
      const customers = await searchStripeCustomers(query);
      res.json({ customers });
    } catch (error: any) {
      console.error("[Billing] Error searching Stripe customers:", error.message);
      res.status(500).json({ error: "Failed to search Stripe customers" });
    }
  });

  app.post("/api/stripe/webhook", async (req: any, res) => {
    try {
      const signature = req.headers["stripe-signature"];
      if (!signature) {
        return res.status(400).json({ error: "Missing stripe-signature header" });
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        return res.status(400).json({ error: "Missing raw body for signature verification" });
      }

      await processStripeWebhook(rawBody, signature);
      res.json({ received: true });
    } catch (error: any) {
      console.error("[Stripe Webhook] Error:", error.message);
      res.status(400).json({ error: "Webhook processing failed" });
    }
  });
}
