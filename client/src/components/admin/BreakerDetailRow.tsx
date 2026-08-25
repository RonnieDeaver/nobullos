// Task #2152 / #2177 — shared "Disconnected at / Auto-retry at / N trips" detail
// row for the auth-dead breaker, mirroring the Front card from Task #2121. Used
// by the Integrations Hub (Slack / Google Ads / SEMrush cards) and by the
// dedicated per-integration console pages so every breaker-backed integration
// surfaces the same actionable detail. Renders nothing unless there's something
// to show.
export function BreakerDetailRow({
  lastTrippedAt,
  cooldownUntil,
  tripCount,
  selfHealParked,
  testIdPrefix,
}: {
  lastTrippedAt?: string | null;
  cooldownUntil?: string | null;
  tripCount?: number;
  // Task #2254 — when true, the auto-retry/self-heal loop has stopped and an
  // operator reconnect is required; shown in place of "Auto-retry at".
  selfHealParked?: boolean;
  testIdPrefix: string;
}) {
  const trippedAt = lastTrippedAt ? new Date(lastTrippedAt) : null;
  const cooldown = cooldownUntil ? new Date(cooldownUntil) : null;
  const trips = tripCount ?? 0;
  if (!trippedAt && !cooldown && !selfHealParked && trips <= 0) return null;
  return (
    <div
      className="flex flex-wrap gap-x-3 gap-y-0.5 pl-5 text-xs text-red-600 dark:text-red-400"
      data-testid={`text-${testIdPrefix}-breaker-details`}
    >
      {trippedAt && (
        <span data-testid={`text-${testIdPrefix}-breaker-tripped-at`} title={trippedAt.toLocaleString()}>
          Disconnected at {trippedAt.toLocaleString()}
        </span>
      )}
      {selfHealParked ? (
        <span data-testid={`text-${testIdPrefix}-breaker-selfheal-parked`}>
          Auto-retry paused — reconnect required
        </span>
      ) : (
        cooldown && (
          <span data-testid={`text-${testIdPrefix}-breaker-cooldown-until`} title={cooldown.toLocaleString()}>
            Auto-retry at {cooldown.toLocaleTimeString()}
          </span>
        )
      )}
      {trips > 0 && (
        <span data-testid={`text-${testIdPrefix}-breaker-trip-count`}>
          {trips} {trips === 1 ? "trip" : "trips"}
        </span>
      )}
    </div>
  );
}
