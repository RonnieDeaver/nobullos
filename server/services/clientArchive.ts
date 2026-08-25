/**
 * Task #3711 — shared client archive/restore side effects.
 *
 * Extracted from the inline fire-and-forget blocks in PATCH
 * /api/clients/:id (server/routes/clients.ts) so the manual archive
 * action and the daily offboarding sweep run the EXACT same side
 * effects and can't drift. Any future archive side effect (cache
 * busts, downstream teardown) belongs here, not in the route.
 *
 * Behavior is unchanged from the route's original blocks:
 *  - archive  → archive the client's comms channel (history preserved,
 *    channel not deleted) so it stops appearing in the sidebar;
 *  - restore  → un-archive the prior channel (or provision a new one if
 *    none ever existed) via `restoreClientChannel`.
 * Both are best-effort: a comms failure logs a warning and never throws,
 * because a channel hiccup must never block or roll back the client
 * update itself.
 */
import type { Client } from "@shared/schema";
import { storage } from "../storage";

export async function applyClientArchivalSideEffects(
  client: Pick<Client, "id" | "firmName">,
  isArchived: boolean,
): Promise<void> {
  if (isArchived) {
    try {
      const { getChannelByClientId, archiveChannel } = await import("../storage/commsStorage");
      const ch = await getChannelByClientId(client.id);
      if (ch) await archiveChannel(ch.id);
    } catch (e: any) {
      console.warn("[ClientArchive] Comms channel archive skipped:", e?.message);
    }
  } else {
    try {
      const { restoreClientChannel } = await import("../storage/commsStorage");
      const slug = (client.firmName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      await restoreClientChannel(client.id, `client-${slug || client.id.slice(0, 8)}`);
    } catch (e: any) {
      console.warn("[ClientArchive] Comms channel restore skipped:", e?.message);
    }
  }
}

/**
 * Archive a client exactly like the manual archive action: flip
 * `isArchived` and apply the shared side effects. Used by the
 * offboarding sweep's `archive_client` step. Throws if the client row
 * no longer exists (the caller decides how to handle that).
 */
export async function archiveClientWithSideEffects(clientId: string): Promise<Client> {
  const client = await storage.updateClient(clientId, { isArchived: true });
  if (!client) {
    throw new Error(`Client ${clientId} not found while archiving`);
  }
  await applyClientArchivalSideEffects(client, true);
  return client;
}
