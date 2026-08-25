import { createHash } from "node:crypto";
import type { Client } from "@shared/models/clients";
import type { RawCommunicationRecord } from "@shared/models/communications";
import {
  extractDomain,
  isAutomatedSenderEmail,
  isCompanyEmail,
  isPublicEmailDomain,
  normalizeEmail,
} from "./companyIdentity";
import type { EvidenceFragment, EvidenceProvenance } from "./judgmentTierGate";

export const INTERNAL_AI_INTERPRETATION_LABEL =
  "Internal AI interpretation — not direct client evidence";

export type EvidenceCommunication = RawCommunicationRecord & {
  perClientSummary?: string | null;
  isMultiClient?: boolean;
};

type Participant = {
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ClientEvidenceIdentity = Pick<Client, "contactEmail" | "emailDomains" | "contactPhone">;

const FRONT_ROLLUP_HEADER =
  /^\[([^\]]+)\]\s+([^\s:\n]+@[^\s:\n]+):\s*\n?([\s\S]*)$/;
const FORWARD_SUBJECT = /^\s*(?:fwd?|forwarded)\s*:/i;
const FORWARD_BOUNDARY = /(?:^|\n)\s*(?:-{2,}\s*(?:original|forwarded) (?:message|email)\s*-{2,}|begin forwarded message:?|forwarded (?:message|email):?|_{4,}\s*forwarded (?:message|email)\s*_{4,}|from:\s*[^\r\n]+\r?\n(?:(?:to|cc|bcc):[^\r\n]*\r?\n){0,6}(?:sent|date|subject):)/i;
const QUOTED_REPLY_BOUNDARY = /(?:^|\n)\s*on .{3,160} wrote:\s*(?:\n|$)/i;

function normalizedParticipants(comm: EvidenceCommunication): Participant[] {
  return Array.isArray(comm.participantsJson)
    ? (comm.participantsJson as Participant[])
    : [];
}

function senderFromParticipants(comm: EvidenceCommunication): string | null {
  const participants = normalizedParticipants(comm);
  const author = participants.find(p => {
    const role = String(p.role ?? "").toLowerCase();
    return role === "author" || role === "external";
  });
  return typeof author?.email === "string" ? normalizeEmail(author.email) : null;
}

function parseFrontRollupPreview(text: string): {
  sender: string;
  body: string;
  occurredAt: string | null;
} | null {
  const firstBlock = text.split(/\n\n---\n\n/)[0] ?? text;
  const match = FRONT_ROLLUP_HEADER.exec(firstBlock);
  if (!match) return null;
  const occurredAtMs = new Date(match[1]).getTime();
  return {
    sender: normalizeEmail(match[2]),
    body: match[3],
    occurredAt: Number.isFinite(occurredAtMs) ? new Date(occurredAtMs).toISOString() : null,
  };
}

function normalizeIdentityText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function frontMessageIndependenceKey(
  sender: string | null,
  occurredAt: string | null,
  body: string,
): string {
  const identity = [
    sender ?? "unknown",
    occurredAt ?? "unknown",
    normalizeIdentityText(body).slice(0, 96),
  ].join("\u0000");
  return `front-message:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function clientSenderAttribution(
  sender: string | null,
  identity: ClientEvidenceIdentity,
): { provenance: EvidenceProvenance; attribution: string } {
  if (!sender) return { provenance: "unknown", attribution: "missing_author" };
  if (isAutomatedSenderEmail(sender)) return { provenance: "automated", attribution: "automated_sender" };
  if (isCompanyEmail(sender)) return { provenance: "internal_staff", attribution: "company_sender" };

  const contactEmail =
    typeof identity.contactEmail === "string" && identity.contactEmail.trim()
      ? normalizeEmail(identity.contactEmail)
      : null;
  if (contactEmail && sender === contactEmail) {
    return { provenance: "client_authored", attribution: "exact_client_contact" };
  }

  const senderDomain = extractDomain(sender);
  const trustedDomains = new Set(
    (identity.emailDomains ?? [])
      .map(domain => String(domain).toLowerCase().trim().replace(/^@/, ""))
      .filter(domain => domain.length > 0 && !isPublicEmailDomain(domain)),
  );
  if (senderDomain && trustedDomains.has(senderDomain)) {
    return { provenance: "client_authored", attribution: "trusted_client_domain" };
  }
  return { provenance: "third_party", attribution: "external_not_client_identity" };
}

function splitForwardedText(text: string, subject: string): {
  direct: string;
  forwarded: string;
} {
  const fullForward = FORWARD_SUBJECT.test(subject);
  const boundaryMatches = [FORWARD_BOUNDARY.exec(text), QUOTED_REPLY_BOUNDARY.exec(text)]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => a.index - b.index);
  const boundary = boundaryMatches[0]?.index ?? -1;
  if (fullForward) return { direct: "", forwarded: text.trim() };

  const candidateDirect = (boundary >= 0 ? text.slice(0, boundary) : text)
    .split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .join("\n")
    .trim();
  const forwarded = boundary >= 0 ? text.slice(boundary).trim() : "";
  return { direct: candidateDirect, forwarded };
}

function commFragment(
  comm: EvidenceCommunication,
  field: string,
  text: string,
  provenance: EvidenceProvenance,
  authorAttribution: string | null = null,
  options: {
    occurredAt?: string | null;
    independenceKey?: string | null;
  } = {},
): EvidenceFragment {
  return {
    id: `communication:${comm.id}:${field}`,
    text,
    provenance,
    sourceType: comm.sourceType,
    sourceId: comm.id,
    field,
    occurredAt: options.occurredAt !== undefined
      ? options.occurredAt
      : comm.timestamp
        ? new Date(comm.timestamp).toISOString()
        : null,
    authorAttribution,
    independenceKey: options.independenceKey ?? null,
  };
}

function classifyContent(
  comm: EvidenceCommunication,
  identity: ClientEvidenceIdentity,
): EvidenceFragment[] {
  const visible = (comm.contentPreview ?? "").substring(0, 500);
  if (!visible.trim()) return [];

  if (
    comm.sourceType === "twilio_sms" &&
    comm.direction === "inbound" &&
    comm.matchStatus === "matched" &&
    comm.matchMethod === "phone_lookup"
  ) {
    const split = splitForwardedText(visible, comm.title ?? "");
    const independenceKey = `twilio-message:${comm.externalSourceId ?? comm.id}`;
    const fragments: EvidenceFragment[] = [];
    if (split.direct) {
      fragments.push(commFragment(
        comm,
        "content",
        split.direct,
        "client_authored",
        "matched_client_phone",
        { independenceKey },
      ));
    }
    if (split.forwarded) {
      fragments.push(commFragment(
        comm,
        "forwarded_content",
        split.forwarded,
        "client_forwarded",
        "matched_client_phone",
        { independenceKey },
      ));
    }
    return fragments;
  }

  if (comm.sourceType !== "front_email") {
    const provenance = comm.direction === "outbound" || comm.direction === "internal"
      ? "internal_staff"
      : "unknown";
    return [commFragment(
      comm,
      "content",
      visible,
      provenance,
      provenance === "unknown"
        ? "unknown_provenance_internal_interpretation"
        : "unsupported_author_shape",
    )];
  }

  const rollup = comm.sourceSubtype === "email_thread" ? parseFrontRollupPreview(visible) : null;
  const sender = rollup?.sender ?? senderFromParticipants(comm);
  const body = rollup?.body ?? visible;
  const occurredAt = rollup?.occurredAt ??
    (comm.timestamp ? new Date(comm.timestamp).toISOString() : null);
  const independenceKey = frontMessageIndependenceKey(sender, occurredAt, body);
  const classified = clientSenderAttribution(sender, identity);
  if (comm.direction !== "inbound" && classified.provenance === "client_authored") {
    classified.provenance = "internal_staff";
    classified.attribution = "non_inbound_transport";
  }
  if (classified.provenance !== "client_authored") {
    return [commFragment(
      comm,
      "content",
      body,
      classified.provenance,
      classified.attribution,
      { occurredAt, independenceKey },
    )];
  }

  const split = splitForwardedText(body, comm.title ?? "");
  const fragments: EvidenceFragment[] = [];
  if (split.direct) {
    fragments.push(commFragment(
      comm,
      "content",
      split.direct,
      "client_authored",
      classified.attribution,
      { occurredAt, independenceKey },
    ));
  }
  if (split.forwarded) {
    fragments.push(commFragment(
      comm,
      "forwarded_content",
      split.forwarded,
      "client_forwarded",
      classified.attribution,
      { occurredAt, independenceKey },
    ));
  }
  return fragments;
}

export function buildCommunicationEvidenceFragments(
  comm: EvidenceCommunication,
  identity: ClientEvidenceIdentity,
  options: { includeContent: boolean; includeGenerated: boolean; digestTitle: boolean },
): EvidenceFragment[] {
  const fragments: EvidenceFragment[] = [];
  const title = options.digestTitle ? (comm.title ?? "").substring(0, 90) : (comm.title ?? "");
  if (title) {
    fragments.push(commFragment(comm, "subject", title, "communication_subject", "transport_metadata"));
  }

  if (options.includeGenerated && comm.perClientSummary) {
    fragments.push(commFragment(
      comm,
      "per_client_summary",
      comm.perClientSummary,
      "ai_generated",
      "internal_ai_interpretation_not_client_evidence",
    ));
  } else if (options.includeGenerated && comm.aiSummary) {
    fragments.push(commFragment(
      comm,
      "ai_summary",
      comm.aiSummary,
      "ai_generated",
      "internal_ai_interpretation_not_client_evidence",
    ));
  }
  if (options.includeGenerated && Array.isArray(comm.aiSignals)) {
    for (const [index, signal] of (comm.aiSignals as Array<Record<string, unknown>>).entries()) {
      if (signal.relevance !== "high" && signal.relevance !== "medium") continue;
      const description = typeof signal.description === "string" ? signal.description : "";
      if (description) {
        fragments.push(commFragment(
          comm,
          `ai_signal:${index}`,
          description,
          "ai_generated",
          "internal_ai_interpretation_not_client_evidence",
        ));
      }
    }
  }
  if (options.includeContent) fragments.push(...classifyContent(comm, identity));
  return fragments;
}