/**
 * Task #4050 — deterministic Zoom → client matching tiers beyond the
 * participant matcher, plus the shared resolution orchestrator every Zoom
 * ingest/reprocess path routes through.
 *
 * Why this module exists: in production only ~1–5% of Zoom comm records were
 * client-attributed. The participant matcher can only see emails/names, but
 * the dominant unmatched class is transcript-first records whose participant
 * list is the internal host alone — the only usable deterministic signals for
 * those are the meeting TOPIC (↔ client firm name) and, once seeded by the
 * email-matching work, participant email domains (↔ clients.emailDomains).
 *
 * Tier semantics (all deterministic, no AI):
 *   1. booked_in_app          — handled by callers BEFORE this module (kept).
 *   2. participant strong     — existing matchClientByParticipants email tiers.
 *   3. trusted_domain         — external human participant email domain is in
 *                               exactly one active client's emailDomains[].
 *   4. topic_firm_name        — normalized topic contains ALL distinctive
 *                               tokens of exactly one active client firm name.
 *   5. participant weak       — contact-name / owner heuristics: demoted to
 *                               review with the suggestion stored (unchanged
 *                               Task #2637 policy).
 *
 * Anything ambiguous (multiple candidate clients, conflicting tiers, or a
 * person-name-shaped topic that merely shares a client surname) is DEMOTED to
 * the review queue with the suggested client + candidate shortlist recorded so
 * operators get one-click confirmation instead of a bare unmatched row.
 *
 * The topic tier deliberately does NOT require non-internal participants:
 * transcript-first records carry host-only participant lists in production
 * (538 of 561 unmatched records in the last 90d had no external email at
 * all), so a participant-presence requirement would make the tier useless
 * for exactly the class it exists to fix. Topic evidence is independent of
 * the participant list — the title names the client account. The
 * person-name-shape guard below keeps prospect calls ("Richard Perez <>
 * NoBull Marketing") out of the auto lane.
 *
 * No imports from zoomIntegration.ts (that file consumes this one); the
 * participant matcher is injected by callers to keep the module cycle-free
 * and unit-testable without dragging the Zoom API surface into tests.
 */

import {
  isCompanyEmail,
  isPublicEmailDomain,
  isCompanyDomain,
  isAutomatedSenderEmail,
  extractDomain,
} from "./companyIdentity";
import {
  hasOnlyInternalParticipants,
  isCommonFirstName,
  type MatchSource,
} from "./matchPolicy";
import { normalizeClientEmailDomains } from "@shared/models/clients";

/** Review reasons introduced by the Task #4050 tiers. */
export const AMBIGUOUS_TRUSTED_DOMAIN_REVIEW_REASON = "ambiguous_trusted_domain";
export const AMBIGUOUS_TOPIC_FIRM_REVIEW_REASON = "ambiguous_topic_firm";
export const PERSON_NAME_TOPIC_REVIEW_REASON = "person_name_topic";
export const CONFLICTING_SIGNALS_REVIEW_REASON = "conflicting_signals";

/**
 * Central strong-vs-weak classifier for participant matchedOn strings.
 * Previously copy-pasted at three call sites (MeetingApply, TranscriptApply,
 * reprocess endpoint) — any new matchedOn prefix must be classified here ONCE.
 * Weak = contact-name heuristics and the owner fallback (Task #2637).
 */
export function isStrongParticipantSignal(matchedOn: string): boolean {
  const mo = matchedOn.toLowerCase();
  return !mo.startsWith("contact_name:") && !mo.startsWith("owner:");
}

export type ZoomMatchClientInput = {
  id: string;
  firmName: string | null;
  emailDomains?: unknown;
  isArchived?: boolean | null;
};

export type ZoomMatchContactInput = {
  name: string | null;
};

export type ZoomMatchIndexes = {
  /** trusted domain → set of active client ids claiming it */
  domainToClientIds: Map<string, Set<string>>;
  /** distinctive firm-name token cores for the topic tier */
  firmCores: Array<{
    clientId: string;
    firmName: string;
    /** every token here must appear (whole-word) in the topic to hit */
    required: string[];
  }>;
  /** normalized contact-name token arrays per client (person-guard confirmation) */
  contactNameTokensByClient: Map<string, string[][]>;
  firmNameByClientId: Map<string, string>;
};

/**
 * Tokens that carry no identity inside a law-firm name. Removing them leaves
 * the distinctive "core" ("Bledsoe Law Firm" → ["bledsoe"], "Burns Smith Law"
 * → ["burns","smith"]). ALL remaining tokens must appear in a topic for a
 * hit, so multi-token cores are inherently collision-safe.
 */
const GENERIC_FIRM_TOKENS = new Set([
  "law", "laws", "firm", "firms", "group", "groups", "legal", "office",
  "offices", "attorney", "attorneys", "lawyer", "lawyers", "associates",
  "partners", "counsel", "esq", "esquire", "llc", "pllc", "pc", "pa", "plc",
  "llp", "lp", "inc", "co", "corp", "corporation", "ltd", "company",
  "the", "of", "by", "and", "a", "an", "at", "for", "on", "in", "your",
]);

/**
 * Company boilerplate stripped from topics before the person-name-shape test
 * ("Richard Perez <> NoBull Marketing" → "richard perez").
 */
const COMPANY_TOPIC_TOKENS = new Set(["nobull", "nobullmarketing", "marketing"]);

export function normalizeZoomTopicTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

export function buildZoomMatchIndexes(
  clients: ZoomMatchClientInput[],
  contactsByClient: Map<string, ZoomMatchContactInput[]>,
): ZoomMatchIndexes {
  const domainToClientIds = new Map<string, Set<string>>();
  const firmCores: ZoomMatchIndexes["firmCores"] = [];
  const contactNameTokensByClient = new Map<string, string[][]>();
  const firmNameByClientId = new Map<string, string>();

  for (const client of clients) {
    if (client.isArchived) continue;
    const firmName = (client.firmName ?? "").trim();
    firmNameByClientId.set(client.id, firmName);

    // Domain index — mirrors frontHardMatch: public + company domains never
    // become trusted evidence even if an operator pastes them into the list.
    for (const domain of normalizeClientEmailDomains(client.emailDomains)) {
      if (isPublicEmailDomain(domain) || isCompanyDomain(domain)) continue;
      let set = domainToClientIds.get(domain);
      if (!set) domainToClientIds.set(domain, (set = new Set()));
      set.add(client.id);
    }

    // Firm core — drop generic tokens, common FIRST names (they mark the
    // founder's given name, not the brand: "James Maloney Law" → ["maloney"]),
    // and sub-3-char fragments ("MJ Law" → ineligible rather than matching
    // every "mj"). Eligibility needs at least one token of length ≥ 4 so
    // initials-only firms never join the tier.
    const tokens = normalizeZoomTopicTokens(firmName);
    const required = [
      ...new Set(
        tokens.filter(
          (t) => !GENERIC_FIRM_TOKENS.has(t) && !isCommonFirstName(t) && t.length >= 3,
        ),
      ),
    ];
    if (required.length >= 1 && required.some((t) => t.length >= 4)) {
      firmCores.push({ clientId: client.id, firmName, required });
    }

    const contacts = contactsByClient.get(client.id) ?? [];
    const nameTokens = contacts
      .map((c) => normalizeZoomTopicTokens(c.name))
      .filter((toks) => toks.length >= 2);
    if (nameTokens.length > 0) contactNameTokensByClient.set(client.id, nameTokens);
  }

  return { domainToClientIds, firmCores, contactNameTokensByClient, firmNameByClientId };
}

export type ZoomTierOutcome =
  | { kind: "auto"; clientId: string; matchedOn: string }
  | {
      kind: "review";
      reviewReason: string;
      suggestedClientId: string | null;
      matchedOn: string;
      candidates: Array<{ clientId: string; matchedOn: string }>;
    }
  | { kind: "none" };

/**
 * Trusted-domain tier: an external, human (non-automated) participant email
 * whose domain appears in exactly one active client's emailDomains[] claims
 * the call. Multiple claiming clients demote to review with the shortlist.
 */
export function resolveZoomTrustedDomainMatch(
  participantEmails: readonly string[],
  indexes: ZoomMatchIndexes,
): ZoomTierOutcome {
  const domainByClient = new Map<string, string>();
  const seen = new Set<string>();
  for (const raw of participantEmails) {
    const email = (raw ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (isCompanyEmail(email) || isAutomatedSenderEmail(email)) continue;
    const domain = extractDomain(email);
    if (!domain || isPublicEmailDomain(domain) || isCompanyDomain(domain)) continue;
    const owners = indexes.domainToClientIds.get(domain);
    if (!owners) continue;
    for (const clientId of owners) {
      if (!domainByClient.has(clientId)) domainByClient.set(clientId, domain);
    }
  }

  if (domainByClient.size === 0) return { kind: "none" };
  if (domainByClient.size === 1) {
    const [clientId, domain] = [...domainByClient.entries()][0];
    return { kind: "auto", clientId, matchedOn: `trusted_domain:${domain}` };
  }
  return {
    kind: "review",
    reviewReason: AMBIGUOUS_TRUSTED_DOMAIN_REVIEW_REASON,
    suggestedClientId: null,
    matchedOn: `trusted_domain:${[...new Set(domainByClient.values())].sort().join("+")}`,
    candidates: [...domainByClient.entries()].map(([clientId, domain]) => ({
      clientId,
      matchedOn: `trusted_domain:${domain}`,
    })),
  };
}

/**
 * Person-name-shape guard for single-token firm cores. A topic that is
 * exactly a bare person name whose surname merely coincides with a client
 * firm token ("Mike Jones" vs "Jones Law Firm", "Richard Perez <> NoBull
 * Marketing" vs "Luis A. Perez, PC") is about a PERSON — usually a prospect
 * sales call — not the client account. Exception: when the named person IS a
 * known contact of that client ("April Jones" for Jones Law Firm), the topic
 * names the actual client contact and the hit stays auto.
 */
function isUnconfirmedPersonNameTopic(
  topicTokens: string[],
  surname: string,
  contactNameTokens: string[][] | undefined,
): boolean {
  const stripped = topicTokens.filter((t) => !COMPANY_TOPIC_TOKENS.has(t));
  if (stripped.length < 2 || stripped.length > 3) return false;
  if (!stripped.every((t) => /^[a-z]+$/.test(t))) return false;
  if (stripped[stripped.length - 1] !== surname) return false;
  // Contact confirmation: same surname AND same first token as a real contact.
  for (const ct of contactNameTokens ?? []) {
    if (ct[ct.length - 1] === surname && ct[0] === stripped[0]) return false;
  }
  return true;
}

/**
 * Topic ↔ firm-name tier: the normalized topic must contain EVERY distinctive
 * token of exactly one active client firm. Multiple hits demote to review
 * with the candidate shortlist; unconfirmed person-name-shaped topics demote
 * with the single candidate as the stored suggestion.
 */
export function resolveZoomTopicFirmMatch(
  topic: string | null | undefined,
  indexes: ZoomMatchIndexes,
): ZoomTierOutcome {
  const topicTokens = normalizeZoomTopicTokens(topic);
  if (topicTokens.length === 0) return { kind: "none" };
  const tokenSet = new Set(topicTokens);

  const hits = indexes.firmCores.filter((core) =>
    core.required.every((t) => tokenSet.has(t)),
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) {
    return {
      kind: "review",
      reviewReason: AMBIGUOUS_TOPIC_FIRM_REVIEW_REASON,
      suggestedClientId: null,
      matchedOn: "topic_firm_name:multiple",
      candidates: hits.map((h) => ({
        clientId: h.clientId,
        matchedOn: `topic_firm_name:${h.firmName}`,
      })),
    };
  }

  const hit = hits[0];
  const matchedOn = `topic_firm_name:${hit.firmName}`;
  if (
    hit.required.length === 1 &&
    isUnconfirmedPersonNameTopic(
      topicTokens,
      hit.required[0],
      indexes.contactNameTokensByClient.get(hit.clientId),
    )
  ) {
    return {
      kind: "review",
      reviewReason: PERSON_NAME_TOPIC_REVIEW_REASON,
      suggestedClientId: hit.clientId,
      matchedOn,
      candidates: [{ clientId: hit.clientId, matchedOn }],
    };
  }
  return { kind: "auto", clientId: hit.clientId, matchedOn };
}

export type ZoomClientResolution =
  | {
      kind: "auto";
      clientId: string;
      matchedOn: string;
      tier: "participant" | "trusted_domain" | "topic_firm_name";
    }
  | {
      kind: "review";
      reviewReason: string;
      suggestedClientId: string | null;
      matchedOn: string;
      candidates: Array<{ clientId: string; matchedOn: string }>;
    }
  | { kind: "none" };

export interface ResolveZoomClientMatchOpts {
  participantEmails: string[];
  participantNames?: string[];
  topic?: string | null;
  source?: MatchSource;
}

export interface ResolveZoomClientMatchDeps {
  /**
   * The existing participant matcher (matchClientByParticipants from
   * zoomIntegration.ts). Injected to keep this module import-cycle-free.
   */
  matchParticipants: (
    participantEmails: string[],
    participantNames: string[],
    opts?: { source?: MatchSource },
  ) => Promise<{ clientId: string; matchedOn: string } | null>;
  /** Preloaded indexes (backfill fast path); otherwise loaded per call. */
  indexes?: ZoomMatchIndexes;
  loadIndexes?: () => Promise<ZoomMatchIndexes>;
}

/** Default index loader used by production call sites. */
export async function loadZoomMatchIndexes(): Promise<ZoomMatchIndexes> {
  const { storage } = await import("../storage");
  const clients = await storage.getClients();
  const contactsByClient = await storage.getClientContactsForClients(
    clients.map((c: { id: string }) => c.id),
  );
  return buildZoomMatchIndexes(clients as ZoomMatchClientInput[], contactsByClient);
}

function mergeCandidates(
  ...lists: Array<Array<{ clientId: string; matchedOn: string }>>
): Array<{ clientId: string; matchedOn: string }> {
  const seen = new Set<string>();
  const out: Array<{ clientId: string; matchedOn: string }> = [];
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.clientId)) continue;
      seen.add(c.clientId);
      out.push(c);
    }
  }
  return out;
}

/**
 * Shared resolution used by MeetingApply, TranscriptApply, the reprocess
 * endpoint, discovery previews, and the re-match backfill. Combination rules
 * are deterministic and conservative: tiers that disagree demote to review
 * instead of guessing.
 */
export async function resolveZoomClientMatch(
  opts: ResolveZoomClientMatchOpts,
  deps: ResolveZoomClientMatchDeps,
): Promise<ZoomClientResolution> {
  const participantEmails = opts.participantEmails ?? [];
  const participantNames = opts.participantNames ?? [];
  const source = opts.source ?? "zoom";

  let participant: { clientId: string; matchedOn: string } | null = null;
  try {
    participant = await deps.matchParticipants(participantEmails, participantNames, {
      source,
    });
  } catch (err: any) {
    console.warn(
      `[ZoomClientMatching] participant matcher failed (continuing with domain/topic tiers): ${err?.message || err}`,
    );
  }
  const allInternal = hasOnlyInternalParticipants(participantEmails);

  // Tier 2: strong participant signal on a not-all-internal call (Task #2637).
  if (participant && isStrongParticipantSignal(participant.matchedOn) && !allInternal) {
    return {
      kind: "auto",
      clientId: participant.clientId,
      matchedOn: participant.matchedOn,
      tier: "participant",
    };
  }

  const indexes =
    deps.indexes ?? (await (deps.loadIndexes ?? loadZoomMatchIndexes)());
  const domainOut = resolveZoomTrustedDomainMatch(participantEmails, indexes);
  const topicOut = resolveZoomTopicFirmMatch(opts.topic, indexes);

  // Tier 3/4 auto lanes, with cross-tier conflict demotion.
  if (domainOut.kind === "auto" && topicOut.kind === "auto") {
    if (domainOut.clientId === topicOut.clientId) {
      return { kind: "auto", clientId: domainOut.clientId, matchedOn: domainOut.matchedOn, tier: "trusted_domain" };
    }
    return {
      kind: "review",
      reviewReason: CONFLICTING_SIGNALS_REVIEW_REASON,
      suggestedClientId: null,
      matchedOn: `${domainOut.matchedOn}|${topicOut.matchedOn}`,
      candidates: mergeCandidates(
        [{ clientId: domainOut.clientId, matchedOn: domainOut.matchedOn }],
        [{ clientId: topicOut.clientId, matchedOn: topicOut.matchedOn }],
      ),
    };
  }
  if (domainOut.kind === "auto") {
    return { kind: "auto", clientId: domainOut.clientId, matchedOn: domainOut.matchedOn, tier: "trusted_domain" };
  }
  if (topicOut.kind === "auto") {
    // An ambiguous domain shortlist that CONTAINS the unique topic hit is
    // agreement, not conflict; a shortlist that excludes it is a conflict.
    if (domainOut.kind === "review") {
      const inShortlist = domainOut.candidates.some((c) => c.clientId === topicOut.clientId);
      if (!inShortlist) {
        return {
          kind: "review",
          reviewReason: CONFLICTING_SIGNALS_REVIEW_REASON,
          suggestedClientId: null,
          matchedOn: `${domainOut.matchedOn}|${topicOut.matchedOn}`,
          candidates: mergeCandidates(domainOut.candidates, [
            { clientId: topicOut.clientId, matchedOn: topicOut.matchedOn },
          ]),
        };
      }
    }
    return { kind: "auto", clientId: topicOut.clientId, matchedOn: topicOut.matchedOn, tier: "topic_firm_name" };
  }

  // Review lanes — first demotion wins the reason; candidates merge, and a
  // weak participant suggestion fills an empty suggestion slot so operators
  // still get one-click confirmation.
  const weakParticipant = participant
    ? { clientId: participant.clientId, matchedOn: participant.matchedOn }
    : null;
  const reviews: Array<Extract<ZoomTierOutcome, { kind: "review" }>> = [];
  if (domainOut.kind === "review") reviews.push(domainOut);
  if (topicOut.kind === "review") reviews.push(topicOut);
  if (reviews.length > 0) {
    const primary = reviews[0];
    const candidates = mergeCandidates(
      ...reviews.map((r) => r.candidates),
      weakParticipant ? [weakParticipant] : [],
    );
    return {
      kind: "review",
      reviewReason: primary.reviewReason,
      suggestedClientId: primary.suggestedClientId ?? weakParticipant?.clientId ?? null,
      matchedOn: primary.matchedOn,
      candidates,
    };
  }

  // Tier 5: weak participant signal — unchanged Task #2637 demotion.
  if (participant) {
    const reviewReason = allInternal ? "solo_internal_participants" : "weak_signal_only";
    return {
      kind: "review",
      reviewReason,
      suggestedClientId: participant.clientId,
      matchedOn: participant.matchedOn,
      candidates: [{ clientId: participant.clientId, matchedOn: participant.matchedOn }],
    };
  }

  return { kind: "none" };
}
