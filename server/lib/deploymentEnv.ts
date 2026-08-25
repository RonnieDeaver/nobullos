/**
 * Task #2289 — Deployment vs. workspace discrimination.
 *
 * On Replit, the deployed (published / autoscale) runtime sets the
 * environment variable `REPLIT_DEPLOYMENT=1`. The interactive workspace
 * process does NOT set it (verified empty in the workspace). We use this
 * as the authoritative gate for "should this process run the Front
 * background workers?".
 *
 * Why this matters: Front OAuth refresh is only safe when ONE writer
 * drives the token at a time. Before this gate, BOTH the deployed
 * instance(s) AND the always-on workspace process ran the Front
 * historical-recovery / coverage / reconciliation / auto-closure loops,
 * so the workspace was a second (third, …) concurrent refresher racing
 * the deployment. When that race landed inside Front's last-24h refresh
 * token rotation window, the loser POSTed a now-consumed refresh token
 * and Front returned `invalid_grant`, tripping the auth-dead breaker for
 * a connection the deployment had just rotated to a healthy token.
 *
 * The cross-process refresh lease (`oauthRefreshLease.ts`) serializes the
 * remaining N deployed instances; this gate removes the workspace process
 * from the pool of refreshers entirely.
 *
 * `FRONT_WORKERS_FORCE_ENABLE=1` is a dev/test escape hatch so a workspace
 * session can deliberately run the Front workers (e.g. local debugging)
 * without faking the deployment env var.
 */

export function isRunningInDeployment(): boolean {
  return process.env.REPLIT_DEPLOYMENT === "1";
}

/**
 * Whether THIS process should run the Front background workers (live sync,
 * coverage refresh, reconciliation, auto-closure, outbound-gap drivers,
 * recovery prune sweep). True in the deployment, or when the dev escape
 * hatch is set. On-demand Front API paths (admin actions, the `/me` probe)
 * are NOT gated by this — they run wherever a request originates.
 */
export function shouldRunFrontBackgroundWorkers(): boolean {
  if (process.env.FRONT_WORKERS_FORCE_ENABLE === "1") return true;
  return isRunningInDeployment();
}
