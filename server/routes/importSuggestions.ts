import type { Express } from "express";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager } from "./middleware";
import { promoteEmailsToClientContact } from "../services/clientContactPromotion";

interface ContactSuggestionCandidate {
  name?: string;
  emails?: string[];
  phones?: string[];
}

interface LocationSuggestionCandidate {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
}

interface ProductSuggestionCandidate {
  product?: string;
  name?: string;
}

function asContactCandidate(value: unknown): ContactSuggestionCandidate {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    name: typeof v.name === "string" ? v.name : undefined,
    emails: Array.isArray(v.emails) ? v.emails.filter((e): e is string => typeof e === "string") : undefined,
    phones: Array.isArray(v.phones) ? v.phones.filter((p): p is string => typeof p === "string") : undefined,
  };
}

function asLocationCandidate(value: unknown): LocationSuggestionCandidate {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    name: typeof v.name === "string" ? v.name : undefined,
    address: typeof v.address === "string" ? v.address : undefined,
    city: typeof v.city === "string" ? v.city : undefined,
    state: typeof v.state === "string" ? v.state : undefined,
  };
}

function asProductCandidate(value: unknown): ProductSuggestionCandidate {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    product: typeof v.product === "string" ? v.product : undefined,
    name: typeof v.name === "string" ? v.name : undefined,
  };
}

const listQuerySchema = z.object({
  clientId: z.string().optional(),
  surface: z.string().optional(),
  entityKind: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  // Task #4348 — offset + total turn the queue into bounded pages. Both
  // are additive: omitting offset keeps the legacy first-200 behavior.
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

const approveBodySchema = z.object({
  // client_contact
  emails: z.array(z.string().email()).optional(),
  contactName: z.string().optional(),
  // client_location
  locationName: z.string().optional(),
  locationAddress: z.string().optional(),
  // product
  product: z.string().optional(),
});

export function registerImportSuggestionRoutes(app: Express) {
  app.get(
    "/api/import-suggestions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const parsed = listQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
        }
        const opts = parsed.data;
        const filterOpts = {
          clientId: opts.clientId,
          surface: opts.surface,
          entityKind: opts.entityKind,
          status: opts.status ?? "pending",
        };
        const [rows, total] = await Promise.all([
          storage.listImportEntitySuggestions({
            ...filterOpts,
            limit: opts.limit ?? 200,
            offset: opts.offset ?? 0,
          }),
          storage.countImportEntitySuggestions(filterOpts),
        ]);

        const reviewerIds = Array.from(
          new Set(rows.map(r => r.reviewedByUserId).filter((v): v is string => !!v)),
        );
        const [allClients, reviewers] = await Promise.all([
          rows.length > 0 ? storage.getClients() : Promise.resolve([]),
          // Task #1573 (Audit Track C, N2): batch the reviewer lookup
          // into a single query instead of one storage.getUser per id.
          reviewerIds.length > 0
            ? db
                .select()
                .from(users)
                .where(inArray(users.id, reviewerIds))
                .catch(() => [] as Array<typeof users.$inferSelect>)
            : Promise.resolve([] as Array<typeof users.$inferSelect>),
        ]);
        const clientMap = new Map(allClients.map(c => [c.id, c.firmName]));
        const reviewerMap = new Map<string, string>();
        for (const u of reviewers) {
          if (!u) continue;
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id;
          reviewerMap.set(u.id, name);
        }

        res.json({
          items: rows.map(r => ({
            ...r,
            clientFirmName: clientMap.get(r.clientId) ?? null,
            reviewedByName: r.reviewedByUserId ? reviewerMap.get(r.reviewedByUserId) ?? null : null,
          })),
          total,
        });
      } catch (err) {
        console.error("[ImportSuggestions] list failed:", err);
        res.status(500).json({ error: "Failed to load import suggestions" });
      }
    },
  );

  app.post(
    "/api/import-suggestions/:id/dismiss",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const id = req.params.id;
        const userId = req.user?.claims?.sub || req.user?.id || null;
        const existing = await storage.getImportEntitySuggestion(id);
        if (!existing) return res.status(404).json({ error: "Suggestion not found" });
        if (existing.status !== "pending") {
          return res.status(409).json({ error: `Suggestion is already ${existing.status}` });
        }
        const updated = await storage.updateImportEntitySuggestion(id, {
          status: "dismissed",
          reviewedByUserId: userId,
          reviewedAt: new Date(),
        });
        res.json({ suggestion: updated });
      } catch (err) {
        console.error("[ImportSuggestions] dismiss failed:", err);
        res.status(500).json({ error: "Failed to dismiss suggestion" });
      }
    },
  );

  app.post(
    "/api/import-suggestions/:id/approve",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const id = req.params.id;
        const userId = req.user?.claims?.sub || req.user?.id || null;
        const parsed = approveBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        }

        const existing = await storage.getImportEntitySuggestion(id);
        if (!existing) return res.status(404).json({ error: "Suggestion not found" });
        if (existing.status !== "pending") {
          return res.status(409).json({ error: `Suggestion is already ${existing.status}` });
        }

        if (existing.entityKind === "client_contact") {
          return await approveClientContact({ req, res, existing, parsed: parsed.data, userId });
        }
        if (existing.entityKind === "client_location") {
          return await approveClientLocation({ req, res, existing, parsed: parsed.data, userId });
        }
        if (existing.entityKind === "product") {
          return await approveProduct({ req, res, existing, parsed: parsed.data, userId });
        }

        return res.status(400).json({
          error: `Approval is not supported for ${existing.entityKind} suggestions`,
        });
      } catch (err) {
        console.error("[ImportSuggestions] approve failed:", err);
        res.status(500).json({ error: "Failed to approve suggestion" });
      }
    },
  );
}

type ApproveCtx = {
  req: any;
  res: any;
  existing: Awaited<ReturnType<typeof storage.getImportEntitySuggestion>> & {};
  parsed: z.infer<typeof approveBodySchema>;
  userId: string | null;
};

async function approveClientContact({ res, existing, parsed, userId }: ApproveCtx) {
  const candidate = asContactCandidate(existing!.candidate);
  const candidateEmails = candidate.emails ?? [];
  const candidateEmailSet = new Set(candidateEmails.map(e => e.toLowerCase()));
  const requestedEmails = parsed.emails;
  const emailsToPromote = requestedEmails && requestedEmails.length > 0
    ? requestedEmails
    : candidateEmails;
  if (emailsToPromote.length === 0) {
    return res.status(400).json({ error: "No emails to promote on this suggestion" });
  }
  const stranger = emailsToPromote.find(e => !candidateEmailSet.has(e.toLowerCase()));
  if (stranger) {
    return res.status(400).json({
      error: `Email "${stranger}" is not part of this suggestion's candidate emails`,
    });
  }

  const contactName = (parsed.contactName ?? candidate.name ?? "").trim();

  const promo = await promoteEmailsToClientContact({
    clientId: existing!.clientId,
    emails: emailsToPromote,
    contactName: contactName || undefined,
    userId: userId ?? undefined,
    explicitOptIn: true,
    auditSource: "import_suggestion_promotion",
  });

  if (promo.added === 0 && !promo.contactId) {
    return res.status(409).json({
      error: "Promotion did not add any contact",
      reason: promo.reason ?? null,
      result: promo,
    });
  }

  const updated = await storage.updateImportEntitySuggestion(existing!.id, {
    status: "promoted",
    reviewedByUserId: userId,
    reviewedAt: new Date(),
    promotedEntityId: promo.contactId,
  });

  res.json({ suggestion: updated, promotion: promo });
}

async function approveClientLocation({ res, existing, parsed, userId }: ApproveCtx) {
  const candidate = asLocationCandidate(existing!.candidate);
  const name = (parsed.locationName ?? candidate.name ?? "").trim();
  const address = (parsed.locationAddress ?? candidate.address ?? "").trim();

  if (!name) {
    return res.status(400).json({ error: "Location name is required" });
  }
  if (!address || address.length < 10) {
    return res.status(400).json({
      error: "A valid full address is required (street, city, state, zip)",
    });
  }

  const { geocodeLocationText } = await import("../mcu/geocoding");
  const geocoded = await geocodeLocationText(name, address);
  if (geocoded.lat == null || geocoded.lng == null) {
    return res.status(400).json({
      error: "Could not validate address. Please enter a valid US address.",
    });
  }

  const { onLocationChanged } = await import("../mcu/worker");

  const location = await storage.createClientLocation({
    name: geocoded.name,
    clientId: existing!.clientId,
    address: geocoded.address,
    city: geocoded.city,
    state: geocoded.state,
    lat: geocoded.lat,
    lng: geocoded.lng,
    stateFips: geocoded.stateFips,
    countyFips: geocoded.countyFips,
    geocodedAt: geocoded.geocodedAt,
    isActive: true,
  }, {
    actorUserId: userId,
    source: "import_suggestion_promotion",
    reason: `POST /api/import-suggestions/${existing!.id}/approve`,
  });

  if (location.lat && location.lng) {
    onLocationChanged();
  }

  const updated = await storage.updateImportEntitySuggestion(existing!.id, {
    status: "promoted",
    reviewedByUserId: userId,
    reviewedAt: new Date(),
    promotedEntityId: location.id,
  });

  res.json({ suggestion: updated, location });
}

async function approveProduct({ res, existing, parsed, userId }: ApproveCtx) {
  const candidate = asProductCandidate(existing!.candidate);
  const requested = (parsed.product ?? candidate.product ?? candidate.name ?? "").trim();
  if (!requested) {
    return res.status(400).json({ error: "No product to promote on this suggestion" });
  }

  const { validateProductList, CANONICAL_PRODUCTS } = await import("../utils/productResolution");
  const { normalized, invalid } = validateProductList([requested]);
  if (invalid.length > 0 || normalized.length === 0) {
    return res.status(400).json({
      error: "Unknown product value. Allowed products: " + CANONICAL_PRODUCTS.join(", ") + ".",
      code: "INVALID_PRODUCT",
      invalid,
      allowed: [...CANONICAL_PRODUCTS],
    });
  }
  const newProduct = normalized[0];

  const client = await storage.getClient(existing!.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const currentProducts = Array.isArray(client.products) ? client.products : [];
  const { normalized: currentNormalized } = validateProductList(currentProducts);
  if (currentNormalized.includes(newProduct)) {
    const updated = await storage.updateImportEntitySuggestion(existing!.id, {
      status: "promoted",
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      promotedEntityId: newProduct,
    });
    return res.json({
      suggestion: updated,
      product: newProduct,
      alreadyPresent: true,
    });
  }

  const nextProducts = [...currentNormalized, newProduct];
  await storage.updateClient(existing!.clientId, { products: nextProducts });

  const updated = await storage.updateImportEntitySuggestion(existing!.id, {
    status: "promoted",
    reviewedByUserId: userId,
    reviewedAt: new Date(),
    promotedEntityId: newProduct,
  });

  res.json({
    suggestion: updated,
    product: newProduct,
    products: nextProducts,
  });
}
