// @db-pool-intent: worker
//
// Task #4049 — trusted email-domain seeding for client attribution.
//
// 96% of Front email traffic sat unattributed because the Task #867
// trusted-domain matcher tier never fired: zero of the active clients had
// `clients.email_domains` populated. This module derives a REVIEWABLE seeding
// plan from two evidence sources and applies it through the normal client
// update path (so the lists stay operator-editable in Client Detail):
//
//   1. Contact emails on file — `client_contacts.emails` plus the client's
//      own `contact_email`. Operator-entered addresses are strong ownership
//      evidence for their private domains.
//   2. Participants of already-matched conversations — domains that human
//      (non-automated) senders used across ≥ MIN_PARTICIPANT_MATCHED_CONVERSATIONS
//      distinct matched conversations of a single client.
//
//   (A third source in the task plan — the client's website domain — has no
//   canonical storage: `clients` / `client_locations` carry no website/URL
//   column, so there is nothing to derive from. Documented, not silently
//   skipped.)
//
// Exclusions (every one surfaced in the plan, never silent):
//   - public/free-mail domains, including subdomains of public providers
//     (`txt.voice.google.com`, `docs.google.com` — shared Google gateways);
//   - the company's own domains;
//   - vendor/platform domains (CallRail, Clio, MyCase… — `seedingTrustPolicy`);
//   - competitor law-firm domains (participant-derived only: an opposing
//     counsel CC'd on matched threads must not become "trusted"; operator-
//     entered CONTACTS on such a domain still count — the roster wins);
//   - domains claimed by MORE THAN ONE client across candidate sets, existing
//     trusted lists, and contact evidence — ambiguity is refused outright,
//     the domain is listed for manual review instead.
//
// Production-shape note (read-replica, 2026-08): contact evidence alone
// covers 55/56 active clients with zero cross-client collisions; participant
// evidence adds shared vendor domains (casefuel.com → 6 clients,
// smith.ai → 4…) which the ambiguity refusal correctly drops.

import { storage } from "../storage";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import {
  isCompanyEmail,
  isCompanyDomain,
  isPublicEmailDomain,
  isAutomatedSenderEmail,
} from "./companyIdentity";
import { isVendorPlatformDomain, isCompetitorDomain } from "./seedingTrustPolicy";
import { normalizeClientEmailDomains } from "@shared/models/clients";
import { invalidateHardMatchIndexes } from "./frontHardMatch";

/**
 * A participant-derived domain must appear (via human senders) in at least
 * this many DISTINCT matched conversations of the same client before it is
 * eligible. One conversation is a coincidence (a CC'd third party); three is
 * a correspondence pattern.
 */
export const MIN_PARTICIPANT_MATCHED_CONVERSATIONS = 3;

export type ClientDomainSeedSource = "contact_email" | "matched_participants";

export interface ClientDomainSeedCandidate {
  domain: string;
  sources: ClientDomainSeedSource[];
  /** # of distinct contact emails on file with this domain (contact source). */
  contactEmails: number;
  /** # of distinct matched conversations with a human sender on this domain. */
  matchedConversations: number;
}

export interface ClientDomainSeedPlanEntry {
  clientId: string;
  firmName: string;
  existingDomains: string[];
  additions: ClientDomainSeedCandidate[];
}

export interface ClientDomainSeedPlan {
  /** Clients that would receive at least one new trusted domain. */
  entries: ClientDomainSeedPlanEntry[];
  totals: {
    activeClients: number;
    clientsGainingDomains: number;
    domainsToAdd: number;
    clientsWithExistingDomains: number;
  };
  excluded: {
    /** Domains claimed by >1 client — refused, need manual review. */
    ambiguous: Array<{ domain: string; firmNames: string[] }>;
    /** Participant-derived domains below the conversation threshold. */
    belowThreshold: number;
    /** Distinct public/company/vendor/competitor domains dropped (sample). */
    filteredDomains: string[];
    /** Participant-derived domains whose only senders were automated. */
    automatedOnly: number;
  };
}

interface ParticipantTuple {
  client_id: string;
  conversation_id: string;
  email: string;
}

function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain.includes(".") || domain.includes(" ")) return null;
  return domain;
}

/**
 * Build the full seeding plan. Read-only — callers decide whether to apply.
 */
export async function deriveClientDomainSeedPlan(): Promise<ClientDomainSeedPlan> {
  const allClients = await storage.getClients();
  const activeClients = allClients.filter((c) => !c.isArchived);
  const activeIds = activeClients.map((c) => c.id);
  const contactsByClient = activeIds.length > 0
    ? await storage.getClientContactsForClients(activeIds)
    : new Map<string, Array<{ emails?: unknown }>>();

  const existingByClient = new Map<string, string[]>();
  for (const client of activeClients) {
    existingByClient.set(client.id, normalizeClientEmailDomains(client.emailDomains as unknown));
  }

  const filteredDomains = new Set<string>();
  // clientId → domain → evidence
  const contactEvidence = new Map<string, Map<string, Set<string>>>();

  const noteContactEmail = (clientId: string, rawEmail: unknown) => {
    if (typeof rawEmail !== "string") return;
    const email = rawEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    if (isCompanyEmail(email)) return;
    // A saved noreply@/notifications@ contact is an automated mailbox, not
    // ownership evidence for the whole domain.
    if (isAutomatedSenderEmail(email)) return;
    const domain = domainOfEmail(email);
    if (!domain) return;
    if (isPublicEmailDomain(domain)) return; // free-mail: never seedable, not worth listing
    if (isCompanyDomain(domain) || isVendorPlatformDomain(domain)) {
      filteredDomains.add(domain);
      return;
    }
    let byDomain = contactEvidence.get(clientId);
    if (!byDomain) contactEvidence.set(clientId, (byDomain = new Map()));
    let emails = byDomain.get(domain);
    if (!emails) byDomain.set(domain, (emails = new Set()));
    emails.add(email);
  };

  for (const client of activeClients) {
    noteContactEmail(client.id, client.contactEmail);
    const contacts = contactsByClient.get(client.id) ?? [];
    for (const contact of contacts) {
      const emails = Array.isArray((contact as { emails?: unknown }).emails)
        ? ((contact as { emails: unknown[] }).emails)
        : [];
      for (const e of emails) noteContactEmail(client.id, e);
    }
  }

  // ── Participant evidence from already-matched conversations ──────────────
  // Flat (client, conversation, email) tuples; automated-sender filtering
  // happens HERE in JS so the predicate stays single-sourced in
  // `companyIdentity.isAutomatedSenderEmail`.
  const tuples = await runWithWorkerDb(() =>
    withDbAttribution("maintenance:client-domain-seeding-participants", async () => {
      const result = await getDb().execute(sql`
        SELECT fse.matched_client_id AS client_id,
               fse.conversation_id   AS conversation_id,
               lower(p->>'email')    AS email
        FROM front_sync_emails fse
        CROSS JOIN LATERAL jsonb_array_elements(fse.participants_json) AS p
        WHERE fse.match_status IN ('auto_matched', 'manually_matched')
          AND fse.matched_client_id IS NOT NULL
          AND p->>'email' IS NOT NULL
          AND position('@' in p->>'email') > 1
      `);
      return (result as unknown as { rows: ParticipantTuple[] }).rows ?? [];
    }),
  );

  const activeIdSet = new Set(activeIds);
  // clientId → domain → set of conversation ids with HUMAN senders
  const participantEvidence = new Map<string, Map<string, Set<string>>>();
  // (clientId, domain) pairs seen ONLY via automated senders so far
  const automatedSeen = new Set<string>();

  for (const t of tuples) {
    if (!t.client_id || !activeIdSet.has(t.client_id)) continue;
    const email = (t.email ?? "").trim();
    if (!email || isCompanyEmail(email)) continue;
    const domain = domainOfEmail(email);
    if (!domain) continue;
    if (isPublicEmailDomain(domain)) continue;
    if (isCompanyDomain(domain) || isVendorPlatformDomain(domain) || isCompetitorDomain(domain)) {
      filteredDomains.add(domain);
      continue;
    }
    if (isAutomatedSenderEmail(email)) {
      automatedSeen.add(`${t.client_id}\u0000${domain}`);
      continue;
    }
    let byDomain = participantEvidence.get(t.client_id);
    if (!byDomain) participantEvidence.set(t.client_id, (byDomain = new Map()));
    let convs = byDomain.get(domain);
    if (!convs) byDomain.set(domain, (convs = new Set()));
    convs.add(t.conversation_id);
  }

  // ── Candidates per client (threshold applied to participant evidence) ────
  let belowThreshold = 0;
  let automatedOnly = 0;
  // clientId → domain → candidate
  const candidates = new Map<string, Map<string, ClientDomainSeedCandidate>>();

  const upsertCandidate = (
    clientId: string,
    domain: string,
    source: ClientDomainSeedSource,
    counts: { contactEmails?: number; matchedConversations?: number },
  ) => {
    const existing = existingByClient.get(clientId) ?? [];
    if (existing.includes(domain)) return; // already trusted — nothing to add
    let byDomain = candidates.get(clientId);
    if (!byDomain) candidates.set(clientId, (byDomain = new Map()));
    let cand = byDomain.get(domain);
    if (!cand) {
      byDomain.set(domain, (cand = { domain, sources: [], contactEmails: 0, matchedConversations: 0 }));
    }
    if (!cand.sources.includes(source)) cand.sources.push(source);
    if (counts.contactEmails) cand.contactEmails = Math.max(cand.contactEmails, counts.contactEmails);
    if (counts.matchedConversations) {
      cand.matchedConversations = Math.max(cand.matchedConversations, counts.matchedConversations);
    }
  };

  for (const [clientId, byDomain] of contactEvidence) {
    for (const [domain, emails] of byDomain) {
      upsertCandidate(clientId, domain, "contact_email", { contactEmails: emails.size });
    }
  }
  for (const [clientId, byDomain] of participantEvidence) {
    for (const [domain, convs] of byDomain) {
      if (convs.size < MIN_PARTICIPANT_MATCHED_CONVERSATIONS) {
        // Contact evidence for the same domain still stands on its own.
        if (!contactEvidence.get(clientId)?.has(domain)) belowThreshold++;
        continue;
      }
      upsertCandidate(clientId, domain, "matched_participants", { matchedConversations: convs.size });
    }
  }
  for (const key of automatedSeen) {
    const [clientId, domain] = key.split("\u0000");
    if (!participantEvidence.get(clientId)?.has(domain) && !contactEvidence.get(clientId)?.has(domain)) {
      automatedOnly++;
    }
  }

  // ── Cross-client ambiguity refusal ────────────────────────────────────────
  // A domain is claimed by: every client that would gain it (candidates) AND
  // every client that already lists it. >1 distinct claimant → refuse.
  const claims = new Map<string, Set<string>>();
  const claim = (domain: string, clientId: string) => {
    let owners = claims.get(domain);
    if (!owners) claims.set(domain, (owners = new Set()));
    owners.add(clientId);
  };
  for (const [clientId, byDomain] of candidates) {
    for (const domain of byDomain.keys()) claim(domain, clientId);
  }
  for (const [clientId, existing] of existingByClient) {
    for (const domain of existing) claim(domain, clientId);
  }

  const firmNameById = new Map(activeClients.map((c) => [c.id, c.firmName] as const));
  const ambiguous: Array<{ domain: string; firmNames: string[] }> = [];
  for (const [domain, owners] of claims) {
    if (owners.size <= 1) continue;
    // Only report domains that were actually up for seeding (an existing
    // multi-client overlap in operator-entered lists is their explicit call).
    const wasCandidate = [...candidates.values()].some((m) => m.has(domain));
    if (!wasCandidate) continue;
    ambiguous.push({
      domain,
      firmNames: [...owners].map((id) => firmNameById.get(id) ?? id).sort(),
    });
    for (const byDomain of candidates.values()) byDomain.delete(domain);
  }
  ambiguous.sort((a, b) => a.domain.localeCompare(b.domain));

  // ── Assemble plan ─────────────────────────────────────────────────────────
  const entries: ClientDomainSeedPlanEntry[] = [];
  for (const client of activeClients) {
    const byDomain = candidates.get(client.id);
    if (!byDomain || byDomain.size === 0) continue;
    const additions = [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
    entries.push({
      clientId: client.id,
      firmName: client.firmName,
      existingDomains: existingByClient.get(client.id) ?? [],
      additions,
    });
  }
  entries.sort((a, b) => a.firmName.localeCompare(b.firmName));

  return {
    entries,
    totals: {
      activeClients: activeClients.length,
      clientsGainingDomains: entries.length,
      domainsToAdd: entries.reduce((sum, e) => sum + e.additions.length, 0),
      clientsWithExistingDomains: activeClients.filter(
        (c) => (existingByClient.get(c.id) ?? []).length > 0,
      ).length,
    },
    excluded: {
      ambiguous,
      belowThreshold,
      filteredDomains: [...filteredDomains].sort().slice(0, 25),
      automatedOnly,
    },
  };
}

export interface ClientDomainSeedApplyResult {
  clientsUpdated: number;
  domainsAdded: number;
  ambiguousRefused: number;
  plan: ClientDomainSeedPlan;
}

/**
 * Re-derive the plan FRESH and write it through `storage.updateClient` (the
 * same path the Client Detail editor uses), then invalidate the hard-match
 * indexes so the matcher sees the new lists immediately. Idempotent: a second
 * apply re-derives and finds nothing to add.
 */
export async function applyClientDomainSeedPlan(): Promise<ClientDomainSeedApplyResult> {
  const plan = await deriveClientDomainSeedPlan();
  let clientsUpdated = 0;
  let domainsAdded = 0;
  for (const entry of plan.entries) {
    const merged = normalizeClientEmailDomains([
      ...entry.existingDomains,
      ...entry.additions.map((a) => a.domain),
    ]);
    const updated = await storage.updateClient(entry.clientId, { emailDomains: merged });
    if (!updated) {
      throw new Error(`Failed to update trusted domains for client ${entry.clientId} (${entry.firmName})`);
    }
    clientsUpdated++;
    domainsAdded += entry.additions.length;
  }
  if (clientsUpdated > 0) invalidateHardMatchIndexes();
  // Task #4762 — domain seeding drains its own backlog: AFTER the hard-match
  // indexes are invalidated (so drain jobs see the new lists, never stale
  // ones), kick the scoped deterministic re-match for every updated client.
  // The 6h-enrolled full-backlog re-match is the backstop. Non-fatal: an
  // enqueue failure must never fail the seed apply that already wrote.
  if (clientsUpdated > 0) {
    try {
      const { enqueueRetroactiveReprocessSafe, periodicDedupeKey } = await import(
        "./retroactiveReprocessControl"
      );
      for (const entry of plan.entries) {
        try {
          await enqueueRetroactiveReprocessSafe({
            clientId: entry.clientId,
            source: "client_domain_seed",
            workloadClass: "interactive_repair",
            dedupeKey: periodicDedupeKey(entry.clientId),
          });
        } catch (err: any) {
          console.warn(
            `[ClientDomainSeeding] re-match enqueue failed for ${entry.clientId} (non-fatal):`,
            err?.message ?? err,
          );
        }
      }
    } catch (err: any) {
      console.warn(
        "[ClientDomainSeeding] re-match enqueue setup failed (non-fatal):",
        err?.message ?? err,
      );
    }
  }
  return { clientsUpdated, domainsAdded, ambiguousRefused: plan.excluded.ambiguous.length, plan };
}
