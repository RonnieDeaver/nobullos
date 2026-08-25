/**
 * Shared, module-level caches of the three directory pools (clients, GAds
 * accounts, LSA accounts) used by the ⌘K palette and the breadcrumb account
 * switchers. The bundle's App.tsx fetched these once at app level; in NoBull OS
 * the Ads OS shell mounts per page, so a module-level promise gives the same
 * "fetched once per session" behavior without a triple fetch on every
 * navigation. All three endpoints are served from the ClickUp directory bundle
 * server-side (10-min TTL), so a refetch after a failure is cheap.
 */

import { api } from "./api";
import type { ClientRef, MonitoredAccount } from "./types";

let clientsP: Promise<ClientRef[]> | null = null;
let gadsP: Promise<MonitoredAccount[]> | null = null;
let lsaP: Promise<MonitoredAccount[]> | null = null;

/** Client list (name + product flags). Failed loads clear the cache so the
 *  next open retries instead of pinning an error forever. */
export function clientPool(): Promise<ClientRef[]> {
  clientsP ??= api
    .clients()
    .then((r) => r.clients)
    .catch((e) => {
      clientsP = null;
      throw e;
    });
  return clientsP;
}

/** Monitored GAds accounts. */
export function gadsPool(): Promise<MonitoredAccount[]> {
  gadsP ??= api.monitoredAccounts().catch((e) => {
    gadsP = null;
    throw e;
  });
  return gadsP;
}

/** Monitored LSA accounts (city-tagged). */
export function lsaPool(): Promise<MonitoredAccount[]> {
  lsaP ??= api.lsaMonitoredAccounts().catch((e) => {
    lsaP = null;
    throw e;
  });
  return lsaP;
}
