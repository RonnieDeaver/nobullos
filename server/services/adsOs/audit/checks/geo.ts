/** GEO checks — Targeting & Geo Integrity (port of audit/checks/geo.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext } from "../context";
import { discrete } from "./base";

// English campaigns (an 'ENG' token in the name) don't need explicit language
// targeting — leaving it on all languages is fine for them.
const ENGLISH_RE = /\bENG\b/i;

/**
 * GEO-01 (gate): every enabled campaign has positive location targeting.
 *
 * Critical (and gate-cap 75) if any campaign is defaulting to all/global.
 */
export function geo01(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  const missing = campaigns.filter((c) => !c.has_positive_location);
  if (!campaigns.length) return discrete("GEO-01", Status.NA, "No enabled campaigns");
  if (missing.length) {
    const ev: Evidence[] = missing.map((c) => ({
      name: c.name,
      id: c.id,
      detail: "no positive location targets",
    }));
    return discrete(
      "GEO-01",
      Status.CRITICAL,
      `${missing.length} of ${campaigns.length} campaigns have no location targeting`,
      ev,
    );
  }
  return discrete("GEO-01", Status.GOOD, `All ${campaigns.length} campaigns target explicit locations`);
}

// Presence == "people in your targeted locations". Anything looser can serve people
// merely *interested* in the area — for a local firm that's wasted spend, so per team
// review it's now CRITICAL. These are the concrete looser values the v24 API returns
// for search campaigns (verified live); UNSPECIFIED/UNKNOWN are intentionally NOT
// flagged so a campaign type where the setting doesn't apply can't trip a false cap.
const NOT_PRESENCE = new Set(["PRESENCE_OR_INTEREST", "SEARCH_INTEREST"]);

/** GEO-02: geo target type = Presence. good: PRESENCE; critical: anything looser. */
export function geo02(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) return discrete("GEO-02", Status.NA, "No enabled campaigns");

  const notPresence = campaigns.filter((c) => NOT_PRESENCE.has(c.positive_geo_target_type));
  if (notPresence.length) {
    const ev: Evidence[] = notPresence.map((c) => ({
      name: c.name,
      id: c.id,
      detail: c.positive_geo_target_type,
    }));
    return discrete(
      "GEO-02",
      Status.CRITICAL,
      `${notPresence.length} campaign(s) not using Presence ('people in') targeting`,
      ev,
    );
  }
  return discrete("GEO-02", Status.GOOD, "All campaigns target Presence");
}

// GEO-03 (negative locations) removed per the team's review.

/** GEO-04: language targeting present (English 'ENG' campaigns exempt). */
export function geo04(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) return discrete("GEO-04", Status.NA, "No enabled campaigns");
  const missing = campaigns.filter((c) => !c.has_language && !ENGLISH_RE.test(c.name));
  if (missing.length) {
    const ev: Evidence[] = missing.map((c) => ({
      name: c.name,
      id: c.id,
      detail: "no language targeting",
    }));
    return discrete("GEO-04", Status.BAD, `${missing.length} campaign(s) have no language targeting`, ev);
  }
  return discrete("GEO-04", Status.GOOD, "All campaigns have appropriate language targeting");
}
