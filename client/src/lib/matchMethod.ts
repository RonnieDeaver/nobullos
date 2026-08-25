export type MatchMethodCategory =
  | "participant_email"
  | "participant_phone"
  | "firm_domain"
  | "firm_name"
  | "contact_name"
  | "semantic"
  | "mixed"
  | "channel_mapping"
  | "booked_in_app"
  | "manual"
  | "manual_approved"
  | "manual_reassigned"
  | "operational_filter"
  | "review_required"
  | "unmatched"
  | "unknown"
  // Task #867 — simplified Front match-method labels.
  | "email_exact"
  | "email_domain"
  | "ai_suggested_accepted"
  | "filter_rule";

export type NormalizedMatchMethod = {
  category: MatchMethodCategory;
  label: string;
  color: string;
  detail: string | null;
};

const COLORS: Record<MatchMethodCategory, string> = {
  participant_email: "bg-blue-50 text-blue-700 border-blue-200",
  participant_phone: "bg-blue-50 text-blue-700 border-blue-200",
  firm_domain: "bg-indigo-50 text-indigo-700 border-indigo-200",
  firm_name: "bg-amber-50 text-amber-700 border-amber-200",
  contact_name: "bg-cyan-50 text-cyan-700 border-cyan-200",
  semantic: "bg-purple-50 text-purple-700 border-purple-200",
  mixed: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  channel_mapping: "bg-blue-50 text-blue-700 border-blue-200",
  booked_in_app: "bg-emerald-50 text-emerald-700 border-emerald-200",
  manual: "bg-green-50 text-green-700 border-green-200",
  manual_approved: "bg-green-50 text-green-700 border-green-200",
  manual_reassigned: "bg-teal-50 text-teal-700 border-teal-200",
  operational_filter: "bg-slate-50 text-slate-600 border-slate-200",
  review_required: "bg-yellow-50 text-yellow-700 border-yellow-200",
  unmatched: "bg-gray-50 text-gray-500 border-gray-200",
  unknown: "bg-gray-50 text-gray-500 border-gray-200",
  // Task #867 — simplified Front match-method labels.
  email_exact: "bg-blue-50 text-blue-700 border-blue-200",
  email_domain: "bg-indigo-50 text-indigo-700 border-indigo-200",
  ai_suggested_accepted: "bg-purple-50 text-purple-700 border-purple-200",
  filter_rule: "bg-slate-50 text-slate-700 border-slate-200",
};

const LABELS: Record<MatchMethodCategory, string> = {
  participant_email: "Participant Email",
  participant_phone: "Participant Phone",
  firm_domain: "Firm Domain",
  firm_name: "Firm Name",
  contact_name: "Contact Name",
  semantic: "Semantic",
  mixed: "Mixed Signals",
  channel_mapping: "Channel Mapping",
  booked_in_app: "Booked In-App",
  manual: "Manual",
  manual_approved: "Approved by reviewer",
  manual_reassigned: "Reassigned by reviewer",
  operational_filter: "Operational Filter",
  review_required: "Pending review",
  unmatched: "Unmatched",
  unknown: "Unknown",
  // Task #867 — simplified Front match-method labels.
  email_exact: "Exact Email Match",
  email_domain: "Trusted Domain",
  ai_suggested_accepted: "AI Suggested (Accepted)",
  filter_rule: "Filter Rule",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DISMISS_REASON_FRIENDLY: Record<string, string> = {
  not_relevant: "Not relevant to any client",
  duplicate: "Duplicate of another call",
  test_call: "Test or internal call",
  other: "Other",
};

export function friendlyDismissReason(rawKey: string | null | undefined): string | null {
  if (!rawKey) return null;
  return DISMISS_REASON_FRIENDLY[rawKey.toLowerCase()] || rawKey;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length);
}

export function normalizeMatchMethod(raw: string | null | undefined): NormalizedMatchMethod {
  const make = (
    category: MatchMethodCategory,
    detail: string | null = null,
    overrideLabel: string | null = null,
  ): NormalizedMatchMethod => ({
    category,
    label: overrideLabel ?? LABELS[category],
    color: COLORS[category],
    detail,
  });

  if (raw == null) return make("unknown");
  const value = String(raw).trim();
  if (value.length === 0) return make("unknown");

  const lower = value.toLowerCase();

  // Explicit category tokens (legacy + new)
  if (lower === "participant_email") return make("participant_email");
  if (lower === "participant_phone") return make("participant_phone");
  if (lower === "firm_domain") return make("firm_domain");
  if (lower === "firm_name") return make("firm_name");
  if (lower === "contact_name") return make("contact_name");
  if (lower === "semantic" || lower === "agent_match") return make("semantic");
  if (lower === "mixed") return make("mixed");
  if (lower === "channel_mapping") return make("channel_mapping");
  // Deterministic match produced by the OS booking tool (Task #840):
  // a Zoom recording was matched to its scheduled meeting (and therefore
  // its client) via the booking row, not via fuzzy/content heuristics.
  if (lower === "booked_in_app" || lower === "booked-in-app") {
    return make("booked_in_app");
  }
  // Task #867 — simplified Front match-method tokens. The backend writes
  // matchReason as `[REASON_CODE] human reason`; we map both the bare
  // tokens and the prefixed reason-code variants to a single label.
  if (lower === "email_exact" || lower === "exact_contact_email_unique") return make("email_exact");
  if (lower === "email_domain" || lower === "exact_client_domain_unique") return make("email_domain");
  if (lower === "ai_suggested_accepted") return make("ai_suggested_accepted");
  if (lower === "filter_rule") return make("filter_rule");
  if (lower.startsWith("[exact_contact_email_unique]")) return make("email_exact", value.replace(/^\[[^\]]+\]\s*/, ""));
  if (lower.startsWith("[exact_client_domain_unique]")) return make("email_domain", value.replace(/^\[[^\]]+\]\s*/, ""));
  if (lower.startsWith("filter rule")) return make("filter_rule", value);
  if (lower.startsWith("manually assigned")) return make("manual", value);

  if (lower === "manual") return make("manual");
  if (lower === "manual_review") return make("manual");
  if (lower === "manual_review:approved") return make("manual_approved");
  if (lower.startsWith("manual_review:reassigned")) {
    const tail = stripPrefix(value, "manual_review:reassigned").replace(/^:/, "");
    return make("manual_reassigned", tail ? `from ${tail}` : null);
  }
  if (lower.startsWith("dismissed:")) {
    const tail = stripPrefix(value, "dismissed:");
    return make("unmatched", tail, "Dismissed");
  }
  if (lower === "dismissed") return make("unmatched", null, "Dismissed");
  if (lower === "operational_filter") return make("operational_filter");
  if (lower.startsWith("backfill_412g:")) {
    // shape: backfill_412g:<outcome>:<priorMethod>
    const tail = stripPrefix(value, "backfill_412g:");
    const parts = tail.split(":");
    const prior = parts.slice(1).join(":");
    return make("review_required", prior ? `Was: ${prior}` : null);
  }
  if (lower === "backfill_412g") return make("review_required");
  if (lower === "review_required" || lower === "pending_review") return make("review_required");
  if (lower === "unmatched" || lower === "no_match") return make("unmatched");
  if (lower === "content_match") return make("firm_name");
  if (lower === "name_match") return make("contact_name");

  // Prefixed shapes produced by the matchers.
  if (lower.startsWith("contact_email:")) return make("participant_email", stripPrefix(value, "contact_email:"));
  if (lower.startsWith("participant_email:")) return make("participant_email", stripPrefix(value, "participant_email:"));
  if (lower.startsWith("participant_phone:")) return make("participant_phone", stripPrefix(value, "participant_phone:"));
  if (lower.startsWith("owner:")) return make("participant_email", `Internal owner ${stripPrefix(value, "owner:")}`);

  if (lower.startsWith("content:firm_name:")) return make("firm_name", stripPrefix(value, "content:firm_name:"));
  if (lower.startsWith("content:firm_variant:")) return make("firm_name", stripPrefix(value, "content:firm_variant:"));
  if (lower.startsWith("content:client_code:")) return make("firm_name", stripPrefix(value, "content:client_code:"));
  if (lower.startsWith("content:contact_name:")) return make("contact_name", stripPrefix(value, "content:contact_name:"));
  if (lower.startsWith("content:")) return make("firm_name", stripPrefix(value, "content:"));

  if (lower.startsWith("firm_name:")) return make("firm_name", stripPrefix(value, "firm_name:"));
  if (lower.startsWith("firm_variant:")) return make("firm_name", stripPrefix(value, "firm_variant:"));
  if (lower.startsWith("client_code:")) return make("firm_name", stripPrefix(value, "client_code:"));
  if (lower.startsWith("firm_domain:")) return make("firm_domain", stripPrefix(value, "firm_domain:"));
  if (lower.startsWith("domain:")) return make("firm_domain", stripPrefix(value, "domain:"));
  if (lower.startsWith("contact_name:")) return make("contact_name", stripPrefix(value, "contact_name:"));

  // Task #4050 — deterministic Zoom tiers: participant email domain matched a
  // client's trusted emailDomains[], or the meeting topic contained exactly
  // one client firm's distinctive name tokens.
  if (lower.startsWith("trusted_domain:")) return make("email_domain", stripPrefix(value, "trusted_domain:"));
  if (lower.startsWith("topic_firm_name:")) {
    return make("firm_name", stripPrefix(value, "topic_firm_name:"), "Topic ↔ Firm Name");
  }

  if (lower.startsWith("agent:")) return make("semantic", stripPrefix(value, "agent:"));
  if (lower.startsWith("semantic:")) return make("semantic", stripPrefix(value, "semantic:"));
  if (lower.startsWith("mixed:")) return make("mixed", stripPrefix(value, "mixed:"));

  // Bare email value (legacy participant-email match)
  if (EMAIL_RE.test(value)) return make("participant_email", value);

  return make("unknown", value);
}

export function matchMethodLabel(raw: string | null | undefined): string {
  return normalizeMatchMethod(raw).label;
}

export function matchMethodColor(raw: string | null | undefined): string {
  return normalizeMatchMethod(raw).color;
}

export function matchMethodDetail(raw: string | null | undefined): string | null {
  return normalizeMatchMethod(raw).detail;
}

export const REVIEW_REASON_LABELS: Record<string, string> = {
  solo_internal_participants: "Solo internal participants",
  weak_signal_only: "Weak signal only",
  contact_name_only_weak: "Contact name only (weak signal)",
  policy_demotion: "Auto-claim blocked by policy",
  agent_review: "Below confidence threshold",
  no_deterministic_booking_match: "No deterministic booking match",
  // Task #4050 — deterministic Zoom tier demotions.
  ambiguous_trusted_domain: "Multiple clients share this email domain",
  ambiguous_topic_firm: "Topic matches multiple firm names",
  person_name_topic: "Topic looks like a person's name",
  conflicting_signals: "Domain and topic signals disagree",
};

export function reviewReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Needs review";
  return REVIEW_REASON_LABELS[reason] || reason.replace(/_/g, " ");
}
