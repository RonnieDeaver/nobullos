/* test-registration
{
  "name": "Zoom deterministic match (Task #840)",
  "scanPaths": [
    "server/services/zoomIntegration.ts",
    "server/storage/bookingStorage.ts"
  ],
  "tier": "medium"
}
test-registration */
/**
 * Task #840 — Zoom deterministic ingestion match test.
 *
 * Invariant under test: when a Zoom recording arrives whose meeting id
 * matches a row in scheduled_meetings (i.e. it was booked through OS),
 * the ingestion code MUST short-circuit the fuzzy participant matchers
 * and tag the match as `booked_in_app`.
 *
 * This guarantees the deterministic round-trip the spec requires:
 *     OS booking  →  Zoom meeting id  →  recording  →  exact same client.
 *
 * Both ingestion entry points (handleZoomMeetingApply for in-meeting webhooks
 * AND handleZoomTranscriptApply for the transcript webhook) must do this
 * lookup BEFORE invoking matchClientByParticipants — otherwise a client
 * with a generic email could get auto-claimed by a different client's
 * participant data.
 */

import * as fs from "fs";
import * as path from "path";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

const SRC = fs.readFileSync(
  path.join(process.cwd(), "server/services/zoomIntegration.ts"),
  "utf8",
);

function sliceFn(name: string): string {
  const startMarker = new RegExp(
    `(?:async\\s+function|function)\\s+${name}\\s*\\(`,
  );
  const start = SRC.search(startMarker);
  if (start < 0) return "";
  // Walk from `start` to the matching closing brace using a depth counter.
  // The first `{` after the signature opens the function body.
  const bodyOpen = SRC.indexOf("{", start);
  if (bodyOpen < 0) return SRC.slice(start);
  let depth = 0;
  let inLine = false;
  let inBlock = false;
  let inStr: string | null = null;
  for (let i = bodyOpen; i < SRC.length; i++) {
    const ch = SRC[i];
    const nx = SRC[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nx === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && nx === "/") {
      inLine = true;
      continue;
    }
    if (ch === "/" && nx === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  return SRC.slice(start);
}

const meetingApply = sliceFn("handleZoomMeetingApply");
const transcriptApply = sliceFn("handleZoomTranscriptApply");

section("1. Both ingestion entry points exist");
{
  assert(meetingApply.length > 0, "handleZoomMeetingApply found in source");
  assert(
    transcriptApply.length > 0,
    "handleZoomTranscriptApply found in source",
  );
}

section("2. Deterministic lookup runs in handleZoomMeetingApply");
{
  assert(
    meetingApply.includes("findScheduledMeetingByZoomIds"),
    "calls storage.findScheduledMeetingByZoomIds",
  );
  assert(
    /booked_in_app/.test(meetingApply),
    "tags matchMethod = 'booked_in_app' on hit",
  );

  // The deterministic lookup MUST run before the fuzzy matcher.
  const detIdx = meetingApply.indexOf("findScheduledMeetingByZoomIds");
  const fuzzyIdx = meetingApply.indexOf("matchClientByParticipants");
  assert(
    detIdx > 0 && (fuzzyIdx === -1 || detIdx < fuzzyIdx),
    "deterministic lookup precedes matchClientByParticipants",
  );
}

section("3. Deterministic lookup runs in handleZoomTranscriptApply");
{
  assert(
    transcriptApply.includes("findScheduledMeetingByZoomIds"),
    "calls storage.findScheduledMeetingByZoomIds",
  );
  assert(
    /booked_in_app/.test(transcriptApply),
    "tags matchMethod = 'booked_in_app' on hit",
  );

  const detIdx = transcriptApply.indexOf("findScheduledMeetingByZoomIds");
  const fuzzyIdx = transcriptApply.indexOf("matchClientByParticipants");
  assert(
    detIdx > 0 && (fuzzyIdx === -1 || detIdx < fuzzyIdx),
    "deterministic lookup precedes matchClientByParticipants",
  );
}

section("4. Storage helper accepts both id + uuid");
{
  const STORAGE = fs.readFileSync(
    path.join(process.cwd(), "server/storage/bookingStorage.ts"),
    "utf8",
  );
  assert(
    /export\s+async\s+function\s+findScheduledMeetingByZoomIds/.test(STORAGE),
    "findScheduledMeetingByZoomIds is exported",
  );
  // Should query against both zoom_meeting_id and zoom_meeting_uuid (or
  // their normalized variants).
  assert(
    /zoomMeetingId|zoom_meeting_id/.test(STORAGE) &&
      /zoomMeetingUuid|zoom_meeting_uuid/.test(STORAGE),
    "looks up by both meeting id and uuid",
  );
}

section("5. Scheduled meetings are created via Zoom API helper");
{
  const ZOOM = fs.readFileSync(
    path.join(process.cwd(), "server/services/zoomIntegration.ts"),
    "utf8",
  );
  assert(
    /export\s+async\s+function\s+createScheduledMeeting/.test(ZOOM),
    "createScheduledMeeting helper exported",
  );
  // Type 2 = scheduled meeting (NOT PMI). Spec requires never using type 4.
  assert(
    /type\s*:\s*2/.test(ZOOM),
    "uses Zoom meeting type 2 (scheduled — never PMI)",
  );
  assert(
    /export\s+async\s+function\s+deleteScheduledMeeting/.test(ZOOM),
    "deleteScheduledMeeting helper exported (used for compensating rollback)",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
