# Front Rematch Verification Report
**Executed:** 2026-04-15T02:43:17.084Z
**Run started:** 2026-04-15T02:43:17.038Z
**Environment:** Empty dataset (no production Front sync emails in this environment)

## 1. Pre-flight Checks

| Check | Status |
|-------|--------|
| Pre-flight passed | Yes |
| Learning mode | **trusted** |
| Decontamination scan clean | Yes |
| Threshold policy valid | Yes |
| Evidence-aware enabled (285D) | Yes |
| Active confidence threshold | 0.78 |
| Active ambiguity gap | 0.08 |
| Shadow threshold | 0.65 |
| Agent memories loaded | 0 |
| Clients with memory | 0 |

**Evidence-Aware Thresholds (Task 285D):**
| Evidence Class | Threshold |
|--------------|-----------|
| Exact deterministic | 0.78 |
| Unique domain | 0.78 |
| Strong heuristic | 0.85 |
| Semantic dominant | 0.9 |
| Mixed | 0.82 |

## 2. Before / After Metrics

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Total emails | 0 | 0 | 0 |
| Unmatched | 0 | 0 | 0 |
| Auto-matched | 0 | 0 | 0 |
| Manually matched | 0 | 0 | 0 |
| Total matched | 0 | 0 | 0 |
| Non-spam match rate | 0.00% | 0.00% | 0.00% → 0.00% |
| Dismissed operational | 0 | 0 | 0 |

## 3. Rematch Execution Details

### Dry Run Preview
- Total processed: 0
- Would newly match: 0
- Would reassign: 0
- Unchanged: 0
- Skipped spam: 0
- Errors: 0

### Live Execution
- **Batches run: 1**
- Total processed: 0
- **Newly matched: 0**
- Reassigned: 0
- Unchanged: 0
- Skipped spam: 0
- Errors: 0

## 4. Evidence Classes Producing Matches

### This Run Only (new matches)
| Evidence Class | Count |
|---------------|-------|

### All Auto-Matches (before)
| Evidence Class | Count |
|---------------|-------|

### All Auto-Matches (after)
| Evidence Class | Count |
|---------------|-------|

## 5. False-Positive Concentration Check (This Run)

### Top Clients by New Auto-Matches
| Client | New Matches |
|--------|------------|

### Spot-Check Sample (Newly Matched This Run)
| Confidence | Evidence | Client | Subject |
|-----------|----------|--------|---------|

## 6. Clients with Zero Matched Communications

**Total: 1 clients**

### Data Gap (1 clients — no communications exist)
| Client | Has Contact Email |
|--------|------------------|
| The Deaver Firm | Yes |

### Matching Gap (0 clients — communications exist but no Front matches)

## 7. Learning Impact

| Metric | Value |
|--------|-------|
| Agent memories before | 0 |
| Agent memories after | 0 |
| Memories learned during run | 0 |
| Batches run | 1 |

## 8. Confidence Assessment

```
Confidence: N/A
  * No Front sync emails in database — verification requires production data
  * Script infrastructure validated: pre-flight, execution, and reporting work correctly
```

## 9. Recommended Follow-Up

- This run executed against an empty dataset (dev/staging environment)
- Re-run this script against the production database with synced Front emails to generate meaningful verification
- 1 clients have no communications at all (data gap) — verify these clients are active
