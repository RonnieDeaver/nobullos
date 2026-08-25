/**
 * Comms search modifier parser — shared between client (popover hints) and server
 * (validation).  Translates a Mattermost-style typed query into structured
 * filter parameters.
 *
 * Supported modifiers:
 *   from:@username  — filter by sender (strip leading @)
 *   in:#channel     — filter by channel slug (strip leading #)
 *   before:YYYY-MM-DD / after:YYYY-MM-DD / on:YYYY-MM-DD — date bounds
 *   "exact phrase"  — quoted phrase match
 *   -excluded       — exclude messages containing this term
 *   plain terms     — regular keyword search
 *
 * All modifiers are combinable.  `on:` is syntactic sugar that sets both
 * `after` to the given date and `before` to the next day.
 */

export interface ParsedSearchModifiers {
  terms: string[];
  phrases: string[];
  excluded: string[];
  fromUsername?: string;
  inChannelSlug?: string;
  before?: string;
  after?: string;
  on?: string;
}

export interface ParsedSearchResult {
  raw: string;
  ftsQuery: string;
  modifiers: ParsedSearchModifiers;
  errors: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

function normalizeDate(raw: string): string | null {
  if (ISO_DATE_RE.test(raw)) return raw;
  const m = raw.match(SLASH_DATE_RE);
  if (m) {
    let [, mon, day, yr] = m;
    if (yr.length === 2) yr = `20${yr}`;
    return `${yr}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return null;
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

type Token =
  | { type: "phrase"; value: string }
  | { type: "modifier"; key: string; value: string }
  | { type: "word"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    if (input[i] === '"') {
      const start = i + 1;
      const end = input.indexOf('"', start);
      if (end === -1) {
        tokens.push({ type: "phrase", value: input.slice(start).trim() });
        i = input.length;
      } else {
        tokens.push({ type: "phrase", value: input.slice(start, end) });
        i = end + 1;
      }
      continue;
    }

    const sub = input.slice(i);
    const spaceRel = sub.search(/\s/);
    const wordEnd = spaceRel === -1 ? input.length : i + spaceRel;
    const word = input.slice(i, wordEnd);
    i = wordEnd;

    if (!word) continue;

    const colonIdx = word.indexOf(":");
    if (colonIdx > 0 && colonIdx < word.length - 1) {
      const key = word.slice(0, colonIdx).toLowerCase();
      if (["from", "in", "before", "after", "on"].includes(key)) {
        const value = word.slice(colonIdx + 1).replace(/^[@#]/, "");
        tokens.push({ type: "modifier", key, value });
        continue;
      }
    }

    tokens.push({ type: "word", value: word });
  }
  return tokens;
}

export function parseSearchQuery(input: string): ParsedSearchResult {
  const raw = input;
  const errors: string[] = [];
  const modifiers: ParsedSearchModifiers = { terms: [], phrases: [], excluded: [] };
  const tokens = tokenize(input.trim());

  for (const token of tokens) {
    if (token.type === "phrase") {
      if (token.value.trim()) modifiers.phrases.push(token.value.trim());
      continue;
    }
    if (token.type === "modifier") {
      const { key, value } = token;
      if (!value) { errors.push(`Modifier "${key}:" has no value`); continue; }
      if (key === "from") {
        modifiers.fromUsername = value;
      } else if (key === "in") {
        modifiers.inChannelSlug = value;
      } else if (key === "before") {
        const d = normalizeDate(value);
        if (!d) { errors.push(`Invalid date for before: "${value}"`); } else { modifiers.before = d; }
      } else if (key === "after") {
        const d = normalizeDate(value);
        if (!d) { errors.push(`Invalid date for after: "${value}"`); } else { modifiers.after = d; }
      } else if (key === "on") {
        const d = normalizeDate(value);
        if (!d) { errors.push(`Invalid date for on: "${value}"`); }
        else {
          modifiers.on = d;
          modifiers.after = d;
          modifiers.before = nextDay(d);
        }
      }
      continue;
    }
    if (token.value.startsWith("-") && token.value.length > 1) {
      modifiers.excluded.push(token.value.slice(1));
    } else if (token.value && token.value !== "-") {
      modifiers.terms.push(token.value);
    }
  }

  const ftsParts = [
    ...modifiers.terms,
    ...modifiers.phrases.map((p) => `"${p}"`),
  ];
  const ftsQuery = ftsParts.join(" ");

  return { raw, ftsQuery, modifiers, errors };
}

export const MODIFIER_HINTS = [
  { prefix: "from:", label: "from:@user", description: "Messages from a specific person" },
  { prefix: "in:", label: "in:#channel", description: "Messages in a specific channel" },
  { prefix: "before:", label: "before:YYYY-MM-DD", description: "Messages before a date" },
  { prefix: "after:", label: "after:YYYY-MM-DD", description: "Messages after a date" },
  { prefix: "on:", label: "on:YYYY-MM-DD", description: "Messages on an exact date" },
  { prefix: '"', label: '"exact phrase"', description: "Match an exact phrase" },
  { prefix: "-", label: "-excluded", description: "Exclude messages with this term" },
] as const;
