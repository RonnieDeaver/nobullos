// @db-pool-intent: ambient
/**
 * NoBull Comms — client channel provisioning.
 *
 * Idempotent backfill that ensures every active (non-archived) client has a
 * private comms channel. Safe to call multiple times (find-or-create per
 * client). Runs once at startup and is triggered on each new client creation.
 */

import {
  provisionClientChannel,
  listActiveClientsWithoutChannel,
} from "../storage/commsStorage";

/**
 * Provision channels for every active client that does not yet have one.
 * Each provision is a separate DB operation — no hold spans multiple clients.
 * Returns the count of newly created channels.
 */
export async function backfillClientChannels(): Promise<{ provisioned: number }> {
  let provisioned = 0;
  try {
    const missing = await listActiveClientsWithoutChannel();
    for (const client of missing) {
      try {
        const slug = (client.firmName ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40);
        const name = `client-${slug || client.id.slice(0, 8)}`;
        const { created } = await provisionClientChannel(client.id, name);
        if (created) provisioned++;
      } catch (err: any) {
        console.warn(
          `[CommsProvisioning] Failed to provision channel for client ${client.id}:`,
          err?.message,
        );
      }
    }
  } catch (err: any) {
    console.warn("[CommsProvisioning] backfillClientChannels failed:", err?.message);
  }
  return { provisioned };
}
