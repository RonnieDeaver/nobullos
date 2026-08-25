import { ChevronDown, ChevronRight, Shield } from "lucide-react";
import { useState } from "react";
import {
  buildEffectivePreview,
  previewHasVisibleChanges,
  type EffectiveLimitsData,
} from "./rateLimitMultipliersPreview";

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  team_lead: "Team Lead",
  account_manager: "Account Manager",
};

function formatWindow(windowMs: number): string {
  if (windowMs <= 0) return "—";
  const seconds = Math.round(windowMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export interface EffectiveRateLimitsPreviewTableProps {
  savedLimits: EffectiveLimitsData;
  editValues: Record<string, string>;
  hasPendingEdits: boolean;
  invalidRoles?: string[];
}

export function EffectiveRateLimitsPreviewTable({
  savedLimits,
  editValues,
  hasPendingEdits,
  invalidRoles,
}: EffectiveRateLimitsPreviewTableProps) {
  const preview = buildEffectivePreview(savedLimits, editValues);
  const { allRoles, rows } = preview;
  const showBadge = hasPendingEdits && previewHasVisibleChanges(preview);
  const invalidRoleSet = new Set(invalidRoles ?? []);
  const isEmpty = rows.length === 0;
  const registeredCategories = Object.keys(savedLimits.categories).sort((a, b) =>
    a.localeCompare(b),
  );
  const registeredCount = registeredCategories.length;
  const [showRegisteredList, setShowRegisteredList] = useState(false);

  return (
    <div className="bg-card rounded-lg border shadow-sm" data-testid="section-effective-limits">
      <div className="p-4 border-b bg-muted/50 rounded-t-lg flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Effective Rate Limits</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Per-category request caps after applying each role's multiplier. Highlighted cells
            preview your unsaved changes; saving produces the authoritative server-computed values.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-xs font-medium text-foreground bg-muted border border-border px-2 py-1 rounded whitespace-nowrap"
            title="Number of limiter categories the server has registered so far. Updates as more routes register their limiters."
            data-testid="badge-registered-count"
          >
            {registeredCount} registered
          </span>
          {showBadge && (
            <span
              className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded whitespace-nowrap"
              data-testid="badge-preview-unsaved"
            >
              Preview (unsaved)
            </span>
          )}
        </div>
      </div>
      {registeredCount > 0 && (
        <div className="px-4 py-2 border-b bg-card">
          <button
            type="button"
            onClick={() => setShowRegisteredList((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showRegisteredList}
            data-testid="button-toggle-registered-list"
          >
            {showRegisteredList ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {showRegisteredList ? "Hide" : "Show"} registered categories
          </button>
          {showRegisteredList && (
            <ul
              className="mt-2 flex flex-wrap gap-1.5"
              data-testid="list-registered-categories"
            >
              {registeredCategories.map((category) => (
                <li
                  key={category}
                  className="text-[11px] font-mono text-foreground bg-muted border border-border px-1.5 py-0.5 rounded"
                  data-testid={`item-registered-category-${category}`}
                >
                  {category}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {isEmpty ? (
        <div
          className="flex flex-col items-center justify-center text-center px-6 py-10 gap-3"
          data-testid="empty-effective-limits"
        >
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
            <Shield className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="space-y-1 max-w-md">
            <p
              className="text-sm font-medium text-foreground"
              data-testid="text-effective-empty-title"
            >
              No rate-limited categories yet
            </p>
            <p
              className="text-xs text-muted-foreground leading-relaxed"
              data-testid="text-effective-empty"
            >
              The server hasn't reported any limiter categories to preview. This usually
              means the app just started and no rate-limited routes have been hit yet, or
              limiter registration hasn't completed. Give it a moment and refresh — if it
              stays empty, check the server logs for limiter startup errors. Your
              multiplier edits are still safe to save and will apply to categories as soon
              as they register.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left p-3 font-medium text-muted-foreground">Category</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Window</th>
              <th className="text-left p-3 font-medium text-muted-foreground">Base</th>
              {allRoles.map(({ role, isNew }) => (
                <th
                  key={role}
                  className="text-left p-3 font-medium text-muted-foreground"
                  data-testid={`header-effective-${role}`}
                >
                  <span className="inline-flex items-center gap-1 flex-wrap">
                    {ROLE_LABELS[role] || role}
                    {isNew && (
                      <span
                        className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded"
                        data-testid={`badge-new-role-${role}`}
                      >
                        new
                      </span>
                    )}
                    {invalidRoleSet.has(role) && (
                      <span
                        className="text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 px-1 py-0.5 rounded"
                        title="Typed multiplier is invalid — column is using the last valid value"
                        data-testid={`badge-invalid-role-${role}`}
                      >
                        using last valid
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.category} data-testid={`row-effective-${row.category}`}>
                <td className="p-3 font-medium text-foreground" data-testid={`text-category-${row.category}`}>
                  {row.category}
                  {!row.roleAware && (
                    <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      not role-aware
                    </span>
                  )}
                </td>
                <td className="p-3 text-muted-foreground" data-testid={`text-window-${row.category}`}>
                  {formatWindow(row.windowMs)}
                </td>
                <td className="p-3 text-muted-foreground" data-testid={`text-base-${row.category}`}>
                  {row.base}
                </td>
                {row.cells.map((cell) => (
                  <td
                    key={cell.role}
                    className={
                      cell.isPreview
                        ? "p-3 text-amber-900 bg-amber-50 border-l border-r border-amber-100"
                        : "p-3 text-foreground"
                    }
                    data-testid={`cell-effective-${row.category}-${cell.role}`}
                    data-preview={cell.isPreview ? "true" : "false"}
                    title={
                      cell.isPreview && cell.savedVal !== null
                        ? `Saved: ${cell.savedVal} • Preview: ${cell.previewVal}`
                        : cell.isPreview
                          ? `Preview: ${cell.previewVal} (new role)`
                          : undefined
                    }
                  >
                    {cell.previewVal}
                    {cell.isPreview && cell.savedVal !== null && (
                      <span
                        className="ml-1 text-[10px] text-amber-700"
                        data-testid={`text-saved-${row.category}-${cell.role}`}
                      >
                        (was {cell.savedVal})
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
