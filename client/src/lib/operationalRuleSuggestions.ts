export type SuggestedRulePart = {
  category: "automated_sender_pattern" | "operational_subject_pattern";
  value: string;
  label?: string;
};

export type RuleSuggestion = {
  id: string;
  title: string;
  description: string;
  rules: SuggestedRulePart[];
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanSubjectStem(subject: string): string {
  let s = (subject ?? "").trim();
  // strip leading Re:/Fwd:/Fw: prefixes (possibly stacked)
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^\s*(re|fwd|fw)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  // strip bracketed prefixes/suffixes like [ticket-123] or (#1234)
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  // strip #1234-style ids
  s = s.replace(/#\d+/g, " ");
  // strip UUIDs
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
  // strip ISO dates (2026-05-26) and short dates (5/26 or 5/26/2026)
  s = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ");
  s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  // strip runs of digits 4 or longer (ticket/order ids)
  s = s.replace(/\b\d{4,}\b/g, " ");
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function generateRuleSuggestions(input: {
  senderEmail?: string | null;
  subject?: string | null;
}): RuleSuggestion[] {
  const suggestions: RuleSuggestion[] = [];
  const email = (input.senderEmail ?? "").trim().toLowerCase();
  const subject = (input.subject ?? "").trim();

  let domain: string | null = null;
  if (email.includes("@")) {
    const parts = email.split("@");
    domain = parts[1]?.trim() || null;

    suggestions.push({
      id: "sender-full",
      title: "Block this exact sender",
      description: email,
      rules: [
        {
          category: "automated_sender_pattern",
          value: `^${escapeRegex(email)}$`,
          label: email,
        },
      ],
    });

    if (domain) {
      suggestions.push({
        id: "sender-domain",
        title: "Block any sender at this domain",
        description: `@${domain}`,
        rules: [
          {
            category: "automated_sender_pattern",
            value: `@${escapeRegex(domain)}$`,
            label: `@${domain}`,
          },
        ],
      });
    }
  }

  const stem = cleanSubjectStem(subject);
  if (stem.length >= 4) {
    suggestions.push({
      id: "subject-stem",
      title: "Block emails with this subject",
      description: stem,
      rules: [
        {
          category: "operational_subject_pattern",
          value: escapeRegex(stem),
          label: stem.slice(0, 80),
        },
      ],
    });

    if (email && domain && stem.length >= 6) {
      suggestions.push({
        id: "combined",
        title: "Block this sender AND this subject",
        description: `${email} + "${stem}"`,
        rules: [
          {
            category: "automated_sender_pattern",
            value: `^${escapeRegex(email)}$`,
            label: email,
          },
          {
            category: "operational_subject_pattern",
            value: escapeRegex(stem),
            label: stem.slice(0, 80),
          },
        ],
      });
    }
  }

  return suggestions;
}
