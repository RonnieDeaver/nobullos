/* test-registration
{
  "name": "Service Desk dept-matcher — prefix extract, label match, filter semantics, import auto-link (Task #3568)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3568: shared dept-matcher — pure string logic (DB-free, network-free) covering prefix extract, label-exact/contains/full-name matching, ambiguous detection, filter semantics (selected dept → matching + unmatchable types), and the import-time auto-link simulation. Gate it so a dash-variant mis-parse or filter-semantics regression is caught before it ships.",
  "tier": "small"
}
test-registration */
/**
 * Unit tests for shared/lib/serviceDeskDeptMatcher.ts
 *
 * Covers the filter behaviour required by Task #3568:
 *   - Department selected → only matching types (by prefix) are shown.
 *   - Truly unmatchable types (no prefix, e.g. bare "General") appear everywhere.
 *   - Import-time auto-link wires the correct departmentId on unambiguous matches.
 *   - Ambiguous matches produce "ambiguous" rather than a wrong assignment.
 *   - Already-assigned types resolve via departmentId (ignoring the name prefix).
 *   - Real prod name shapes (en dash, em dash, plain hyphen, "Option N" artifacts).
 */

import assert from "node:assert/strict";
import {
  stripOptPrefix,
  extractDeptLabel,
  extractRtPrefix,
  matchDeptForPrefix,
  resolveRequestTypeDept,
} from "../shared/lib/serviceDeskDeptMatcher";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const dept = (id: string, name: string) => ({ id, name });

const DEPTS = [
  dept("dept-gbp", "Fulfillment – GBP / Local SEO"),
  dept("dept-billing", "Admin – Billing"),
  dept("dept-cs", "Admin – Client Success"),
  dept("dept-marketing", "Admin – Company Marketing"),
  dept("dept-ads", "Fulfillment – Google Ads"),
];

// "Option N" artifacts from ClickUp (Task #3540)
const DEPTS_WITH_OPTION_PREFIX = [
  dept("dept-gbp", "Option 1Fulfillment – GBP / Local SEO"),
  dept("dept-billing", "Option 2Admin – Billing"),
];

// ─── stripOptPrefix ─────────────────────────────────────────────────────────────

function runStripOptPrefix() {
  assert.equal(stripOptPrefix("Option 1Fulfillment – GBP / Local SEO"), "Fulfillment – GBP / Local SEO");
  assert.equal(stripOptPrefix("Option 12 Client Success"), "Client Success");
  assert.equal(stripOptPrefix("Option  3 Google Ads"), "Google Ads");
  assert.equal(stripOptPrefix("Admin – Billing"), "Admin – Billing", "no prefix left unchanged");
  assert.equal(stripOptPrefix("Option 1option-named-type"), "option-named-type");
  console.log("  ✓ stripOptPrefix: all cases");
}

// ─── extractDeptLabel ──────────────────────────────────────────────────────────

function runExtractDeptLabel() {
  assert.equal(extractDeptLabel("Fulfillment – GBP / Local SEO"), "GBP / Local SEO");
  assert.equal(extractDeptLabel("Admin – Billing"), "Billing");
  assert.equal(extractDeptLabel("Option 1Fulfillment – GBP / Local SEO"), "GBP / Local SEO", "strips Option N");
  assert.equal(extractDeptLabel("Fulfillment — Google Ads"), "Google Ads", "em dash");
  assert.equal(extractDeptLabel("Fulfillment - Client Success"), "Client Success", "plain hyphen");
  assert.equal(extractDeptLabel("NoSeparator"), null, "unmatched → null");
  console.log("  ✓ extractDeptLabel: all cases");
}

// ─── extractRtPrefix ──────────────────────────────────────────────────────────

function runExtractRtPrefix() {
  assert.equal(extractRtPrefix("GBP / Local SEO – Citation Cleanup"), "GBP / Local SEO");
  assert.equal(extractRtPrefix("Billing – Refund Request"), "Billing");
  assert.equal(extractRtPrefix("Google Ads — Campaign Pause"), "Google Ads", "em dash");
  assert.equal(extractRtPrefix("Google Ads - Keyword Add"), "Google Ads", "plain hyphen");
  assert.equal(extractRtPrefix("General"), "General", "no dash → returns whole name");
  console.log("  ✓ extractRtPrefix: all cases");
}

// ─── matchDeptForPrefix ────────────────────────────────────────────────────────

function runMatchDeptForPrefix() {
  // Exact label match (score 100)
  {
    const r = matchDeptForPrefix("GBP / Local SEO", DEPTS);
    assert.equal(r.kind, "matched");
    if (r.kind === "matched") {
      assert.equal(r.deptId, "dept-gbp");
      assert.equal(r.reason, "label exact");
    }
  }

  // Label-contains match (score 80): prefix shorter than label
  {
    const r = matchDeptForPrefix("Billing", DEPTS);
    assert.equal(r.kind, "matched");
    if (r.kind === "matched") assert.equal(r.deptId, "dept-billing");
  }

  // Label-contains match: label shorter than prefix
  {
    const localDepts = [dept("dept-gbp", "Fulfillment – GBP")];
    const r = matchDeptForPrefix("GBP / Local SEO", localDepts);
    assert.equal(r.kind, "matched", "label ⊂ prefix → label contains");
    if (r.kind === "matched") assert.equal(r.deptId, "dept-gbp");
  }

  // No match
  {
    const r = matchDeptForPrefix("General", DEPTS);
    assert.equal(r.kind, "no_match");
  }

  // Ambiguous: two departments both satisfy the same score tier
  {
    const ambigDepts = [
      dept("d1", "Group – Foo Bar"),
      dept("d2", "Other – Foo Bar"),
    ];
    const r = matchDeptForPrefix("Foo Bar", ambigDepts);
    assert.equal(r.kind, "ambiguous");
  }

  // Option-N prefix stripped from dept names before matching
  {
    const r = matchDeptForPrefix("GBP / Local SEO", DEPTS_WITH_OPTION_PREFIX);
    assert.equal(r.kind, "matched");
    if (r.kind === "matched") assert.equal(r.deptId, "dept-gbp");
  }

  // Full-name-contains fallback (score 60)
  {
    const localDepts = [dept("dept-gbp", "Fulfillment GBP Local SEO")]; // no separator
    const r = matchDeptForPrefix("GBP Local SEO", localDepts);
    assert.equal(r.kind, "matched");
    if (r.kind === "matched") assert.equal(r.deptId, "dept-gbp");
  }

  // Exact match wins over contains match when both are present
  {
    const mixedDepts = [
      dept("exact", "Fulfillment – Google Ads"),
      dept("contains", "Fulfillment – Google Ads Management"),
    ];
    const r = matchDeptForPrefix("Google Ads", mixedDepts);
    assert.equal(r.kind, "matched");
    if (r.kind === "matched") assert.equal(r.deptId, "exact");
  }

  console.log("  ✓ matchDeptForPrefix: all cases");
}

// ─── resolveRequestTypeDept ────────────────────────────────────────────────────

function runResolveRequestTypeDept() {
  // 1. Stored departmentId takes precedence (even if name prefix doesn't match)
  {
    const rt = { departmentId: "dept-billing", name: "GBP / Local SEO – Citation Cleanup" };
    assert.equal(resolveRequestTypeDept(rt, DEPTS), "dept-billing", "stored id wins");
  }

  // 2. NULL departmentId → falls through to name-prefix matching
  {
    const rt = { departmentId: null, name: "GBP / Local SEO – Citation Cleanup" };
    assert.equal(resolveRequestTypeDept(rt, DEPTS), "dept-gbp");
  }

  // 3. Truly unmatchable (bare "General") → null → show under every dept
  {
    const rt = { departmentId: null, name: "General" };
    assert.equal(resolveRequestTypeDept(rt, DEPTS), null, "unmatchable → null → show everywhere");
  }

  // 4. Ambiguous prefix → "ambiguous" → caller treats as unmatched
  {
    const ambigDepts = [
      dept("d1", "Group – Foo Bar"),
      dept("d2", "Other – Foo Bar"),
    ];
    const rt = { departmentId: null, name: "Foo Bar – Do Something" };
    assert.equal(resolveRequestTypeDept(rt, ambigDepts), "ambiguous");
  }

  // 5. The filter semantics: when a dept is selected, show types whose
  //    resolved dept matches OR whose resolved dept is null (unmatchable) OR
  //    resolved dept is "ambiguous". Both null and ambiguous are shown everywhere
  //    so nothing becomes unreachable.
  //    This exercises the exact logic in ServiceDeskCreate.tsx filteredTypes.
  {
    const depts = [
      ...DEPTS,
      // Add two depts that will make "Shared" prefix ambiguous
      dept("d-shared-a", "GroupA – Shared"),
      dept("d-shared-b", "GroupB – Shared"),
    ];
    const types = [
      { id: "rt1", departmentId: null, name: "GBP / Local SEO – Citation Cleanup", active: true },
      { id: "rt2", departmentId: null, name: "Billing – Refund Request", active: true },
      { id: "rt3", departmentId: null, name: "General", active: true },
      { id: "rt4", departmentId: "dept-gbp", name: "Billing – Something", active: true },
      { id: "rt5", departmentId: null, name: "Shared – Something", active: true },
    ];
    const selectedDeptId = "dept-gbp";
    const visible = types.filter((t) => {
      if (!t.active) return false;
      const resolved = resolveRequestTypeDept(t, depts);
      return resolved === selectedDeptId || resolved === null || resolved === "ambiguous";
    });
    const visibleIds = visible.map((t) => t.id).sort();
    // rt1 matches by prefix, rt3 is unmatchable (null), rt4 is explicitly assigned to dept-gbp,
    // rt5 is ambiguous (matches both d-shared-a and d-shared-b equally) → shown everywhere
    assert.deepEqual(visibleIds, ["rt1", "rt3", "rt4", "rt5"], "dept-gbp selected: rt1 (prefix), rt3 (unmatchable), rt4 (explicit), rt5 (ambiguous); rt2 excluded");
  }

  console.log("  ✓ resolveRequestTypeDept: all cases");
}

// ─── Import-time auto-link simulation ─────────────────────────────────────────

function runImportAutoLink() {
  // Simulate what the import endpoint does for a new RT:
  // auto-link when unambiguous, leave null when ambiguous or no-match.
  function autoLinkDept(optName: string, depts: { id: string; name: string }[]): string | null {
    const prefix = extractRtPrefix(optName);
    const result = matchDeptForPrefix(prefix, depts);
    return result.kind === "matched" ? result.deptId : null;
  }

  // Unambiguous prefix match → set departmentId
  assert.equal(autoLinkDept("GBP / Local SEO – Citation Cleanup", DEPTS), "dept-gbp");
  assert.equal(autoLinkDept("Google Ads – Campaign Pause", DEPTS), "dept-ads");

  // No match → null (stays unassigned)
  assert.equal(autoLinkDept("General", DEPTS), null);

  // Ambiguous → null (stay unassigned, surface via existing auto-match dry-run)
  {
    const ambigDepts = [
      dept("d1", "Group – Shared"),
      dept("d2", "Other – Shared"),
    ];
    assert.equal(autoLinkDept("Shared – Something", ambigDepts), null);
  }

  // "Option N" artifact in dept name should not block matching
  assert.equal(autoLinkDept("GBP / Local SEO – Citation Cleanup", DEPTS_WITH_OPTION_PREFIX), "dept-gbp");

  console.log("  ✓ import auto-link simulation: all cases");
}

// ─── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("Service Desk dept-matcher unit tests (Task #3568):");
  runStripOptPrefix();
  runExtractDeptLabel();
  runExtractRtPrefix();
  runMatchDeptForPrefix();
  runResolveRequestTypeDept();
  runImportAutoLink();
  console.log("All dept-matcher assertions passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
