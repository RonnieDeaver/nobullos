// Task #5297 — shared client-creation core, extracted from the `POST
// /api/clients` handler so a second writer (the onboarding intake endpoint)
// can create a client under the exact same validation/ownership rules
// without duplicating that ~100-line responsibility (architecture-governor:
// "reuse canonical patterns, never build a second path for the same
// responsibility").
//
// Deliberately excludes location + team-assignment handling — those aren't
// part of the *minimum* required client-creation fields, and only
// `POST /api/clients` (the full "Add Client" form) collects them. Both
// callers still run `prepareClientTeamSeed` (validation-only, no writes)
// BEFORE calling this function so a bad team-assignment selection still
// rejects the whole request without a half-created client, exactly as
// before this extraction.
import { storage } from "../storage";
import { hasRole } from "../routes/middleware";
import { insertClientSchema, type Client } from "@shared/schema";

export interface CreateValidatedClientParams {
  /** Raw request body with `locations`/`teamAssignments` already stripped. */
  rawBody: Record<string, any>;
  actingUserId: string;
  actingUserRole: string | null | undefined;
  /** Attributed on audit-log rows and in `[ClientCreate]` log lines. */
  route: string;
}

export type CreateValidatedClientResult =
  | { ok: true; client: Client; normalizedProducts: string[] }
  | { ok: false; status: number; body: Record<string, any> };

/**
 * Validates + creates a client exactly like `POST /api/clients` does:
 * role-based ownerId self-assignment, `insertClientSchema` parsing, product
 * list validation, vendor-identifier screening, `storage.createClient`, tag/
 * segment evaluation, retroactive Front re-match enqueue, an audit-log
 * entry, and best-effort comms-channel provisioning. All side effects past
 * `storage.createClient` are non-fatal (logged, never thrown) — once the
 * client row exists this function always resolves `ok: true`.
 */
export async function createValidatedClient(
  params: CreateValidatedClientParams,
): Promise<CreateValidatedClientResult> {
  const { actingUserId, actingUserRole, route } = params;

  let bodyData: Record<string, any> = params.rawBody;
  if (!hasRole(actingUserRole, "account_manager")) {
    const { ownerId, ...rest } = bodyData;
    bodyData = { ...rest, ownerId: actingUserId };
  }

  if (bodyData.clientStartDate && typeof bodyData.clientStartDate === "string") {
    bodyData.clientStartDate = new Date(bodyData.clientStartDate);
  }

  const parsed = insertClientSchema.safeParse(bodyData);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: parsed.error.issues } };
  }

  const clientData = parsed.data;
  const { validateProductList, CANONICAL_PRODUCTS } = await import("../utils/productResolution");
  const productsInput = Array.isArray(clientData.products) ? clientData.products : [];
  const { normalized: normalizedProducts, invalid: invalidProducts } = validateProductList(productsInput);
  if (invalidProducts.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Unknown product value(s) submitted. Allowed products: " + CANONICAL_PRODUCTS.join(", ") + ".",
        code: "INVALID_PRODUCTS",
        invalid: invalidProducts,
        allowed: [...CANONICAL_PRODUCTS],
      },
    };
  }
  if (normalizedProducts.length === 0) {
    return { ok: false, status: 400, body: { error: "At least one product is required to create a client." } };
  }
  clientData.products = normalizedProducts;

  // Task #4790 — vendor/receipt identifiers are never client identifiers.
  {
    const { findVendorIdentifierViolations, vendorIdentifierRefusalMessage } = await import(
      "../services/seedingTrustPolicy"
    );
    const violations = findVendorIdentifierViolations({
      emailDomains: clientData.emailDomains,
      emails: clientData.contactEmail ? [clientData.contactEmail] : undefined,
    });
    if (violations.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: vendorIdentifierRefusalMessage(violations),
          code: "VENDOR_IDENTIFIER_REFUSED",
          violations,
        },
      };
    }
  }

  const client = await storage.createClient(clientData);

  // Task #4329 — rule tags + segment membership evaluate on write (never
  // fails the write; the periodic sweep heals any miss).
  try {
    const { evaluateRecordWriteSafe } = await import("../services/tagSegmentEngine");
    await evaluateRecordWriteSafe("client", client.id);
  } catch (err: any) {
    console.warn("[ClientCreate] Tag/segment evaluation failed (non-fatal):", err?.message ?? err);
  }

  // Task #4762 — a client created WITH trusted email domains drains its own
  // backlog. Non-fatal.
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
      console.warn("[CreateClient] domain re-match enqueue failed (non-fatal):", err?.message ?? err);
    }
  }

  // Task #1941 — audit-log client creation (and the initial product set).
  try {
    const { insertActivityLogs } = await import("../storage/activityStorage");
    const events: any[] = [
      {
        userId: actingUserId ?? null,
        actionType: "client_created",
        route,
        actionDetail: `Created client ${client.firmName ?? client.id}`,
        metadata: { clientId: client.id, clientFirmName: client.firmName ?? null, products: normalizedProducts },
        sessionId: null,
        duration: null,
        timestamp: new Date(),
      },
      ...normalizedProducts.map((p) => ({
        userId: actingUserId ?? null,
        actionType: "product_added",
        route,
        actionDetail: `Added product ${p} to ${client.firmName ?? client.id}`,
        metadata: { clientId: client.id, clientFirmName: client.firmName ?? null, product: p },
        sessionId: null,
        duration: null,
        timestamp: new Date(),
      })),
    ];
    await insertActivityLogs(events);
  } catch (logErr: any) {
    console.error("[ClientCreate] Audit log failed:", logErr?.message);
    // Task #1986 — surface a persistent failure to operators rather than
    // letting the History popover just silently stay empty.
    try {
      const { recordClientAuditLogWriteFailure } = await import("../services/clientAuditLogFailureAlerts");
      void recordClientAuditLogWriteFailure({
        operation: "create",
        clientId: client.id,
        clientFirmName: client.firmName ?? null,
        eventCount: normalizedProducts.length + 1,
        error: logErr,
      });
    } catch (alertErr: any) {
      console.error("[ClientCreate] Audit-log failure alert errored:", alertErr?.message ?? alertErr);
    }
  }

  // Provision a private comms channel for the new client (fire-and-forget).
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

  return { ok: true, client, normalizedProducts };
}
