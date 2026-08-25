# Command Panel — Missing Product Budgets (Audit & Runbook)

Task #4027. A client's Command Panel can hold `lsa` / `google_ads` / `webinar`
in `product_types` while the matching budget column (`lsa_budget` /
`google_ads_budget` / `webinar_budget`) is NULL. Task #4022 deliberately lets
this state persist through non-products saves (blocking unrelated section
saves was worse), so nothing forces the gap closed until an operator edits
Products & Budget for that client.

## How the gap is surfaced

The Command Panel read view renders a red **"Budget missing"** notice inside
each affected product block (`renderMissingBudgetNotice` in
`client/src/components/CommandPanel.tsx`; test ids
`warning-missing-budget-{lsa|google_ads|webinar}`). The LSA block now renders
even when its budget is NULL (pre-#4027 it was hidden entirely, making the gap
invisible). Guarded by
`tests/client/command-panel-budget-validation-scope.test.tsx` (smoke).

## How to close a gap

Open the client → Command Panel → edit **Products & Budget** → enter the real
budget (from the operator/source system — never invent a value) → Save. The
save-time requirement enforces a budget for every selected product in that
flow.

## Policy decision (recorded)

The product-without-budget state **is allowed to persist indefinitely** from
non-products saves. Budgets must come from operators, so no backfill or
auto-fill is shipped; visibility (the read-view notice) plus the Products &
Budget save-time requirement are the closing mechanism. Rationale also lives
in the `handleSave` comment in `client/src/components/CommandPanel.tsx`.

## Audit snapshot — 2026-08-07

Query (run against dev, then the read-only production replica):

```sql
SELECT cp.client_id, c.firm_name,
  ('lsa'        = ANY(cp.product_types)) AND cp.lsa_budget        IS NULL AS lsa_missing,
  ('google_ads' = ANY(cp.product_types)) AND cp.google_ads_budget IS NULL AS gads_missing,
  ('webinar'    = ANY(cp.product_types)) AND cp.webinar_budget    IS NULL AS webinar_missing
FROM command_panels cp JOIN clients c ON c.id = cp.client_id
WHERE (('lsa'        = ANY(cp.product_types)) AND cp.lsa_budget        IS NULL)
   OR (('google_ads' = ANY(cp.product_types)) AND cp.google_ads_budget IS NULL)
   OR (('webinar'    = ANY(cp.product_types)) AND cp.webinar_budget    IS NULL)
ORDER BY c.firm_name;
```

Development (1 panel):

| Firm | Missing |
| --- | --- |
| The Deaver Firm (`42d5a0d6`) | LSA, Google Ads |

Production (12 panels):

| Firm | Missing |
| --- | --- |
| Ackah Law (`7704fb50`) | LSA |
| New one (`71caad8a`) | LSA, Google Ads |
| Newman Law (`1cfc9210`) | LSA, Google Ads |
| Ragab Law Firm (`99a4534a`) | LSA, Google Ads |
| Speedwell Law PLLC (`3d75b94c`) | LSA, Google Ads |
| Speedwell Law PLLC (`3f35fbfa`) | LSA, Google Ads |
| Speedwell Law PLLC (`c0609c24`) | LSA, Google Ads |
| Speedwell Law PLLC (`bb19e86d`) | LSA, Google Ads |
| Speedwell Law PLLC (`3d28a92f`) | LSA, Google Ads |
| Speedwell Law PLLC (`42c1cfe9`) | LSA, Google Ads |
| Speedwell Law PLLC (`3f5f4a43`) | LSA, Google Ads |
| The Deaver Firm (`42d5a0d6`) | LSA, Google Ads |

(Client ids abbreviated to their first segment; re-run the query above for
full ids and the current state.) Note: the seven "Speedwell Law PLLC" rows are
distinct client records — likely duplicates; tracked separately (Task #4037).

To re-audit later, just re-run the SQL above against each environment.
