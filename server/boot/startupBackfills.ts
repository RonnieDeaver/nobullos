/**
 * Boot — startup backfills.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * client codes, comms channel provisioning, product normalization, location geocode.
 */

import { withDbAttribution as _withDbAttribution } from "../db";
import { log } from "./httpApp";

export function kickStartupBackfills(): void {
  // Backfill client codes for any clients missing them (uses PG sequence for atomicity)
  // fire-and-forget (here + the blocks below): each backfill catches + logs internally.
  void (async () => { await _withDbAttribution("startup:client-code-backfill", async () => {
    try {
          const { db } = await import("../db");
      const { clients } = await import("@shared/schema");
      const { sql, asc } = await import("drizzle-orm");
      const { isNull } = await import("drizzle-orm");
      await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS client_code_seq START WITH 1`);
      const maxRaw = await db.execute(sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(client_code FROM 'NB-([0-9]+)') AS INTEGER)), 0) AS max_num
        FROM clients WHERE client_code IS NOT NULL
      `);
      const maxRows = Array.isArray(maxRaw) ? maxRaw : (maxRaw as any).rows ?? [];
      const maxNum = Number(maxRows[0]?.max_num || 0);
      if (maxNum > 0) {
        await db.execute(sql`SELECT setval('client_code_seq', ${maxNum})`);
      }
      const uncoded = await db.select({ id: clients.id }).from(clients).where(isNull(clients.clientCode)).orderBy(asc(clients.createdAt));
      if (uncoded.length > 0) {
        for (const c of uncoded) {
          const seqRaw = await db.execute(sql`SELECT nextval('client_code_seq') as nextval`);
          const seqRows = Array.isArray(seqRaw) ? seqRaw : (seqRaw as any).rows ?? [];
          const code = `NB-${String(Number(seqRows[0]?.nextval)).padStart(4, '0')}`;
          await db.update(clients).set({ clientCode: code }).where(sql`${clients.id} = ${c.id}`);
        }
        log(`Backfilled ${uncoded.length} client codes`);
      }
    } catch (e) {
      console.warn("Client code backfill skipped:", e);
    }
  }); })();

  // Provision comms channels for all active clients that don't have one yet.
  void (async () => { await _withDbAttribution("startup:comms-channel-backfill", async () => {
    try {
      const { backfillClientChannels } = await import("../services/commsProvisioning");
      const { provisioned } = await backfillClientChannels();
      if (provisioned > 0) log(`[CommsProvisioning] Provisioned ${provisioned} client channel(s)`);
    } catch (e) {
      console.warn("Comms channel backfill skipped:", e);
    }
  }); })();

  // Task 635: One-time normalization of legacy product values stored on
  // existing clients. The product normalizer was expanded to accept aliases
  // like "Google Business Profile", "google ads", and "Local Service Ads",
  // but rows imported before that change still hold non-canonical strings
  // until they are re-saved. Run normalizeProductList against every row so
  // reports and product-gated features see the canonical set everywhere.
  // Idempotent: rows already canonical produce identical arrays and skip the
  // UPDATE, and re-running the loop is a no-op.
  void (async () => { await _withDbAttribution("startup:client-products-normalization", async () => {
    try {
          const { db } = await import("../db");
      const { clients } = await import("@shared/schema");
      const { sql, isNotNull } = await import("drizzle-orm");
      const { normalizeProductList, validateProductList } = await import("@shared/productResolution");

      const rows = await db
        .select({ id: clients.id, products: clients.products })
        .from(clients)
        .where(isNotNull(clients.products));

      let updated = 0;
      let rowsWithUnknownValues = 0;
      let totalUnknownValues = 0;
      const unknownSamples: { clientId: string; invalid: string[] }[] = [];
      for (const row of rows) {
        const current = Array.isArray(row.products) ? row.products : [];
        if (current.length === 0) continue;
        // Task #656: surface any values the normalizer cannot map so a typo
        // or new product that hasn't been added to the alias table doesn't
        // silently disappear from a client's products array on restart.
        const { invalid } = validateProductList(current);
        if (invalid.length > 0) {
          rowsWithUnknownValues++;
          totalUnknownValues += invalid.length;
          if (unknownSamples.length < 10) {
            unknownSamples.push({ clientId: row.id, invalid });
          }
        }
        const normalized = normalizeProductList(current);
        const isSame =
          normalized.length === current.length &&
          normalized.every((p, i) => p === current[i]);
        if (isSame) continue;
        await db
          .update(clients)
          .set({ products: normalized })
          .where(sql`${clients.id} = ${row.id}`);
        updated++;
      }
      if (updated > 0) {
        log(`[ClientProductsBackfill] Normalized products on ${updated} client row(s)`);
      }
      if (totalUnknownValues > 0) {
        console.warn(
          `[ClientProductsBackfill] Dropped ${totalUnknownValues} unrecognized product value(s) across ${rowsWithUnknownValues} client row(s). ` +
          `Add aliases to shared/productResolution.ts if these are real products. Samples: ` +
          JSON.stringify(unknownSamples),
        );
        // Task #1110 — also raise an admin-visible Slack alert so a missing
        // alias doesn't silently drop values on every restart unnoticed.
        try {
          const { recordClientProductsUnknownValues } = await import(
            "../services/clientProductsBackfillAlerts"
          );
          await recordClientProductsUnknownValues({
            totalUnknownValues,
            rowsWithUnknownValues,
            samples: unknownSamples,
          });
        } catch (alertErr) {
          console.warn(
            "[ClientProductsBackfill] failed to dispatch unknown-values alert:",
            alertErr,
          );
        }
      }
    } catch (e) {
      console.warn("Client products normalization backfill skipped:", e);
    }
  }); })();

  void (async () => { await _withDbAttribution("startup:location-geocode-backfill", async () => {
    try {
          const { db } = await import("../db");
      const { clientLocations } = await import("@shared/schema");
      const { isNull, or } = await import("drizzle-orm");
      const { geocodeLocationText } = await import("../mcu/geocoding");

      // Task #836 Phase 2: respect the large-backfills kill switch
      // before issuing the count query so a noisy startup with the
      // switch engaged doesn't even read the table.
      const { isKillSwitchEnabled } = await import("../services/killSwitches");
      if (isKillSwitchEnabled("large_backfills")) {
        log("[LocationBackfill] Skipped — large_backfills kill switch engaged");
        return;
      }

      const ungeocodedLocations = await db.select().from(clientLocations)
        .where(or(isNull(clientLocations.lat), isNull(clientLocations.lng)));

      if (ungeocodedLocations.length === 0) return;

      log(`[LocationBackfill] Found ${ungeocodedLocations.length} locations without coordinates, starting backfill...`);
      let geocoded = 0;
      let failed = 0;

      for (const loc of ungeocodedLocations) {
        try {
          const result = loc.address && loc.address.trim().length > 10
            ? await geocodeLocationText(loc.name, loc.address.trim())
            : await geocodeLocationText(loc.name);
          if (result.lat != null && result.lng != null) {
          const { sql } = await import("drizzle-orm");
            await db.update(clientLocations)
              .set({
                name: result.name,
                address: result.address,
                city: result.city,
                state: result.state,
                lat: result.lat,
                lng: result.lng,
                stateFips: result.stateFips,
                countyFips: result.countyFips,
                geocodedAt: result.geocodedAt,
              })
              .where(sql`id = ${loc.id}`);
            geocoded++;
          } else {
            failed++;
          }
        } catch (err) {
          failed++;
          console.warn(`[LocationBackfill] Error processing location "${loc.name}":`, err);
        }
      }

      log(`[LocationBackfill] Complete: ${geocoded} geocoded, ${failed} failed out of ${ungeocodedLocations.length} total`);
      if (geocoded > 0) {
        const { onLocationChanged } = await import("../mcu/worker");
        onLocationChanged();
      }
    } catch (e) {
      console.warn("Location geocode backfill skipped:", e);
    }
  }); })();
}
