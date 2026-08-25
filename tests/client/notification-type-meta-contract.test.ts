/* test-registration
{
  "name": "Notification type meta contract — every known category keeps a distinct icon + intentional tone, tone chip classes stay in lockstep with the tone union, unknown categories fall back to Bell/neutral with a prettified label (Task #4474)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4474: fast (<1s), pure, DB-free module-contract guard; a silent drift here collapses notification types back into identical grey rows across the bell dropdown and inbox, which nothing else pins.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4474 — contract test for client/src/lib/notificationTypeMeta.ts.
 *
 * The bell dropdown and /notifications inbox tell notification types apart
 * purely by the icon + tone this module maps for each category. Nothing else
 * guarded the mapping: a category rename (server side) or a tone edit could
 * silently drop a category into the Bell/neutral fallback or collapse two
 * categories into visually identical rows. This test pins:
 *
 *  - the known-category set itself (a server-side rename that this module
 *    doesn't follow shows up as an unexpected fallback here),
 *  - a distinct icon per known category (pairwise, and never the fallback
 *    Bell),
 *  - each category's intentional tone per the module's tone discipline
 *    (comms = info, direct-to-you = primary, booking = ok, operational
 *    alerts = warn, rest neutral),
 *  - distinct human labels,
 *  - NOTIFICATION_TONE_CLASSES lockstep with the NotificationTone union
 *    (every tone has a non-empty class entry; no extra keys),
 *  - the unknown-category fallback: Bell icon, neutral tone, prettified
 *    label (never raw snake_case), and the bare "Notification" label for
 *    null/undefined/empty/separator-only input.
 *
 * Hermetic: pure function imports only — no DOM, no fetch, no server.
 */

import assert from "node:assert/strict";
import { Bell } from "lucide-react";
import {
  NOTIFICATION_TONE_CLASSES,
  notificationTypeMeta,
  type NotificationTone,
} from "../../client/src/lib/notificationTypeMeta";

/**
 * The full known-category contract: category → expected tone + label.
 * Deliberately duplicated from the module (not imported) so an accidental
 * edit there fails here instead of silently re-pinning itself.
 */
const EXPECTED: Record<string, { tone: NotificationTone; label: string }> = {
  "comms.sms": { tone: "info", label: "SMS" },
  "comms.call": { tone: "info", label: "Call" },
  "comms.voicemail": { tone: "info", label: "Voicemail" },
  booking: { tone: "ok", label: "Booking" },
  mention: { tone: "primary", label: "Mention" },
  assignment: { tone: "primary", label: "Assignment" },
  agent: { tone: "neutral", label: "Agent" },
  feedback: { tone: "neutral", label: "Feedback" },
  service_desk: { tone: "neutral", label: "Service desk" },
  crm: { tone: "neutral", label: "CRM" },
  system: { tone: "warn", label: "System" },
  queue_health: { tone: "warn", label: "Queue health" },
};

const TONES: NotificationTone[] = ["neutral", "ok", "warn", "info", "primary"];

let checks = 0;
function check(cond: boolean, msg: string): void {
  checks++;
  assert.ok(cond, msg);
}

// --- Known categories: intentional tone + label, never the fallback ------
const seenIcons = new Map<unknown, string>();
const seenLabels = new Map<string, string>();
for (const [category, expected] of Object.entries(EXPECTED)) {
  const meta = notificationTypeMeta(category);
  check(
    meta.tone === expected.tone,
    `${category}: tone ${meta.tone} !== intentional ${expected.tone}`,
  );
  check(
    meta.label === expected.label,
    `${category}: label ${JSON.stringify(meta.label)} !== ${JSON.stringify(expected.label)}`,
  );
  check(
    meta.icon !== Bell,
    `${category}: renders the fallback Bell icon — it fell out of the known map`,
  );
  const iconDup = seenIcons.get(meta.icon);
  check(
    iconDup === undefined,
    `${category}: icon reused by ${iconDup} — two categories render identically`,
  );
  seenIcons.set(meta.icon, category);
  const labelDup = seenLabels.get(meta.label);
  check(
    labelDup === undefined,
    `${category}: label ${JSON.stringify(meta.label)} reused by ${labelDup}`,
  );
  seenLabels.set(meta.label, category);
}

// --- Tone chip classes in lockstep with the tone union --------------------
const classKeys = Object.keys(NOTIFICATION_TONE_CLASSES).sort();
assert.deepEqual(
  classKeys,
  [...TONES].sort(),
  "NOTIFICATION_TONE_CLASSES keys drifted from the NotificationTone union",
);
checks++;
for (const tone of TONES) {
  const cls = NOTIFICATION_TONE_CLASSES[tone];
  check(
    typeof cls === "string" && cls.trim().length > 0,
    `tone ${tone}: empty chip class`,
  );
}
// Every tone a known category uses must be styleable.
for (const [category] of Object.entries(EXPECTED)) {
  const meta = notificationTypeMeta(category);
  check(
    meta.tone in NOTIFICATION_TONE_CLASSES,
    `${category}: tone ${meta.tone} has no chip class entry`,
  );
}

// --- Unknown-category fallback --------------------------------------------
const unknown = notificationTypeMeta("shiny_new-category.alerts");
check(unknown.icon === Bell, "unknown category: expected fallback Bell icon");
check(unknown.tone === "neutral", "unknown category: expected neutral tone");
check(
  unknown.label === "Shiny new category alerts",
  `unknown category: label not prettified (got ${JSON.stringify(unknown.label)})`,
);
check(
  !/[._-]/.test(unknown.label),
  "unknown category: label leaked raw separator characters",
);

for (const empty of [null, undefined, "", "._-"] as const) {
  const meta = notificationTypeMeta(empty as string | null | undefined);
  check(
    meta.icon === Bell && meta.tone === "neutral" && meta.label === "Notification",
    `empty-ish input ${JSON.stringify(empty)}: expected bare fallback meta`,
  );
}

console.log(`notification-type-meta-contract: ${checks} checks passed`);
