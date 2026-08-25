/**
 * Prod-actions kernel (F7, Task #4154): shared types, state-string arrays,
 * and the composition-root contract for the domain-module registry.
 *
 * Relocated verbatim from the head of server/services/prodActionsRegistry.ts.
 * This module must stay import-free of every other prodActions/* module —
 * domains, composition, and engine all depend on it.
 */


// Single source of truth for the valid prod-action state strings. The
// discriminated unions below derive their `state` discriminants from
// these, and tests reference them instead of re-listing the strings
// inline (so adding a new state here — as "blocked" was in Task #2111 —
// can't silently drift the assertions). The compile-time checks further
// down guarantee the unions and these arrays stay in lockstep.
export const PROD_ACTION_STATUS_STATES = [
  "pending",
  "applied",
  "not-needed",
  "error",
  "blocked",
] as const;

export type ProdActionStatusState = (typeof PROD_ACTION_STATUS_STATES)[number];


export const PROD_ACTION_OUTCOME_STATES = [
  "applied",
  "not-needed",
  "error",
  "blocked",
] as const;

export type ProdActionOutcomeState = (typeof PROD_ACTION_OUTCOME_STATES)[number];


export type ProdActionStatus =
  // Task #4762 — `working: true` marks a pending row whose own background
  // drain is OBSERVABLY progressing right now (an in-process drain loop or
  // fanned-out queue chain is walking the backlog). The engine reports such
  // rows as calm auto-managed work ("working — N of M" via the detail)
  // instead of amber operator work. Only set it from direct evidence
  // (isDrainRunning / an active chain probe), never from hope.
  | { state: "pending"; detail: string; working?: boolean }
  | { state: "applied"; detail: string }
  | { state: "not-needed"; detail: string }
  | { state: "error"; detail: string }
  // Task #2111 — reconnect-required. An auth-gated action whose backing
  // integration login is expired/disconnected. Operator-recoverable
  // (reconnect the named integration), NOT a real bug — rendered amber,
  // kept out of error counts/alerting. `integration` names what to
  // reconnect so the UI can link to the Integrations Hub.
  //
  // Task #4840 — `integration` presence is the flavor discriminator:
  //   - WITH `integration`: auth-dead reconnect-required ("Needs
  //     reconnect" badge, Integrations Hub CTA, self-heal reconnect page).
  //     Every genuine auth block must name it (the engine classifier and
  //     the Front/SEMrush direct returns already do).
  //   - WITHOUT `integration`: waiting on preconditions on a healthy
  //     integration (soak windows, evidence gates, manual data review).
  //     Rendered as a neutral waiting state; never pages admins.
  | { state: "blocked"; detail: string; integration?: string };


export type ProdActionOutcome =
  | { state: "applied"; detail: string; rowsAffected?: number }
  | { state: "not-needed"; detail: string }
  | { state: "error"; detail: string }
  // Task #2111 — see ProdActionStatus "blocked".
  | { state: "blocked"; detail: string; integration?: string };


// Compile-time guards: if a new state is added to (or removed from) the
// discriminated unions without updating the arrays above (or vice
// versa), these mutual-assignability checks fail typecheck — keeping the
// single source of truth honest in both directions.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _statusStatesInSync: Exact<
  ProdActionStatus["state"],
  ProdActionStatusState
> = true;

const _outcomeStatesInSync: Exact<
  ProdActionOutcome["state"],
  ProdActionOutcomeState
> = true;
void _statusStatesInSync;
void _outcomeStatesInSync;


/**
 * Task #2086 — opt-in self-heal metadata. An action carrying this field
 * is declared safe for the self-heal scheduler
 * (`prodActionSelfHeal.ts`) to run automatically on a cadence so the CEO
 * no longer has to apply recurring, idempotent maintenance actions by
 * hand. ONLY recurring + idempotent + breaker/pause-aware maintenance
 * actions set this; `selfHeal === undefined` means NOT eligible for
 * automation (the action stays manual-only via the CEO panel).
 */
export interface ProdActionSelfHeal {
  /**
   * Minimum spacing between automatic runs after a run that did work
   * (outcome `applied`). Lets a real backlog drain at this cadence.
   */
  cadenceMs: number;
  /**
   * Longer spacing after a run that did NOT do work (`not-needed`) or
   * that errored / was blocked by a breaker, so an idle or stuck action
   * is checked infrequently instead of every tick.
   */
  backoffMs: number;
}


/**
 * Task #4054 — REQUIRED convergence taxonomy. Every registered action must
 * declare which of the two shapes its pending feed has, so the panel badge
 * can distinguish "operator attention needed" from "healthy always-on
 * maintenance that simply has routine work again":
 *
 * - `converging`: one successful apply settles the action. Its pending
 *   count MUST reach zero after a press and stay there under normal
 *   operation — a later non-zero count is a genuine new incident. This is
 *   the default for one-shot ramps, cutovers, historical backfills, and
 *   incident-repair drains whose feeder was closed at ingest time.
 *
 * - `continuous`: routine operation legitimately re-produces work (new
 *   mail, new imports, new scans), and a named always-on loop drains it
 *   without an operator. A continuous action MUST have that loop: either
 *   self-heal enrollment (`selfHeal`) or a `loopHealth` probe describing an
 *   external scheduler — `assertProdActionConvergenceInvariants()` enforces
 *   this at module load. While the loop is healthy, a `pending` status is
 *   reported as auto-managed (badge-excluded); `error`/`blocked` states
 *   ALWAYS surface as needing attention regardless of class.
 *
 * The guard test (tests/prod-actions-convergence-taxonomy.test.ts) fails
 * any new action that ships a pending feed with no terminal-stamping or
 * ingest-time closure story — declare the class deliberately.
 */
export type ProdActionConvergence =
  | { kind: "converging" }
  | {
      kind: "continuous";
      /** Human-readable name of the always-on loop that drains this action. */
      loop: string;
      /**
       * Optional health probe for loops OUTSIDE the self-heal scheduler
       * (e.g. a dedicated cron/scheduler). Self-heal-enrolled actions omit
       * this — their health derives from the durable self-heal readout.
       * Must never throw; return `{ healthy: false }` with a detail instead.
       */
      loopHealth?: () => Promise<{ healthy: boolean; detail?: string }>;
    };

export interface ProdAction {
  id: string;
  title: string;
  description: string;
  change: string;
  /**
   * Task #4054 — required convergence class (see ProdActionConvergence).
   * There is deliberately NO default: every new action must decide whether
   * its pending feed converges after one apply or is continuously re-fed
   * by routine inflow (and if so, name the loop that drains it).
   */
  convergence: ProdActionConvergence;
  status(actorId?: string | null): Promise<ProdActionStatus>;
  apply(
    actorId?: string | null,
    input?: { confirmation?: string },
  ): Promise<ProdActionOutcome>;
  /**
   * Opt-in marker for the Task #2086 self-heal scheduler. Undefined =
   * manual-only (NOT eligible for automatic runs).
   */
  selfHeal?: ProdActionSelfHeal;
  /**
   * Task #4019 — manual lever: the Apply-all pass NEVER executes this
   * action (it records a synthetic not-needed outcome instead) and the
   * self-heal scheduler ignores it as usual (no `selfHeal`). The only way
   * to fire it is its dedicated per-action endpoint
   * (POST /api/admin/prod-actions/:actionId/apply), surfaced as its own
   * button in the panel's Manual levers section. For operator levers whose
   * firing must be a deliberate individual choice (e.g. the Zoom S2S
   * emergency rollback — a pending rollback under Apply-all would bounce
   * the mode right back on every routine press).
   */
  manualLever?: true;
  /**
   * Optional typed confirmation for an irreversible manual lever. The phrase
   * is served to the CEO panel and is also validated by the action itself, so
   * calling the protected route directly cannot bypass the destructive gate.
   */
  destructiveConfirmation?: {
    phrase: string;
    warning: string;
  };
  /**
   * Task #4762 — REQUIRED drain declaration for converging actions that
   * are neither self-heal-enrolled nor manual levers: a stated,
   * operator-facing reason why reaching zero genuinely requires a human
   * (a deliberate policy flip, a reviewed one-shot repair, an external
   * console step). `assertProdActionConvergenceInvariants()` enforces at
   * module load that every converging action declares exactly one drain
   * path — `selfHeal` (the scheduler presses it), `manualLever` (the
   * lever IS the drain), or this explicit human gate — so a new action
   * can never strand an amber pending row silently again. The reason is
   * surfaced verbatim in the panel next to the amber row.
   *
   * Mutually exclusive with `selfHeal` and `manualLever` (an enrolled or
   * lever action already has its no-human drain story). Converging-only:
   * continuous actions declare their drain via `convergence.loop`.
   */
  humanGate?: { reason: string };
  /**
   * Task #4762 — served-purpose probe for manual levers (and one-shot
   * residue actions): returns `{ served: true }` once the lever's target
   * state is fully reached (e.g. rollback impossible because the legacy
   * rows are retired; residue count is 0 with nothing left to strip).
   * The engine then reports the row as retired — the panel moves it from
   * the Manual levers section into History with the completion note —
   * while the action stays registered (Apply-all audit contract intact,
   * per-action endpoint still functional). Computed live on every status
   * read, so a lever legitimately RETURNS to the lever list if later
   * churn re-creates work (e.g. new inactive-product residue).
   *
   * Must never throw for routine "cannot verify" conditions — return
   * `{ served: false }` so the lever stays visible (fail toward
   * visibility). Converging-only, like the levers it retires.
   */
  servedPurpose?: () => Promise<{ served: boolean; note?: string }>;
}


// ─── F7 composition-root contract ────────────────────────────────────
//
// The registry is composed from explicit domain modules (no filesystem
// discovery, no globs, no DI). Each domain module exports its actions plus
// a `ProdActionDomain` collection; ./composition.ts imports every domain
// explicitly, fixes the operator-facing order in one literal array, and
// asserts the two views agree at module load.

/** A cohesive slice of the production-actions registry (one domain module). */
export interface ProdActionDomain {
  readonly name: string;
  readonly actions: readonly ProdAction[];
}

/**
 * Composition-root guard (F7): the ordered PROD_ACTIONS array and the domain
 * collections must agree exactly. Throws loudly at module load when:
 *  - a domain registered no actions (emptied module / rotted collection),
 *  - the same action id appears in two domains (or twice in one),
 *  - the same id appears twice in the ordered array (double render/execute),
 *  - an ordered-array entry is owned by no registered domain,
 *  - an ordered-array entry is not the identical object its domain registered
 *    (a copy or substitute sharing the id),
 *  - a domain action is missing from the ordered array.
 * Order itself is deliberately NOT derived from domains: the literal array in
 * ./composition.ts is the single source of operator-facing panel + apply-all
 * execution order.
 */
export function assertProdActionDomainComposition(
  domains: readonly ProdActionDomain[],
  ordered: readonly ProdAction[],
): void {
  const owner = new Map<string, { domainName: string; action: ProdAction }>();
  for (const domain of domains) {
    if (domain.actions.length === 0) {
      throw new Error(
        `[prod-actions] domain "${domain.name}" registered no actions — a domain module was emptied or its collection list rotted`,
      );
    }
    for (const action of domain.actions) {
      const prev = owner.get(action.id);
      if (prev !== undefined) {
        throw new Error(
          `[prod-actions] duplicate action id "${action.id}" across domains "${prev.domainName}" and "${domain.name}"`,
        );
      }
      owner.set(action.id, { domainName: domain.name, action });
    }
  }
  const orderedIds = new Set<string>();
  for (const action of ordered) {
    if (orderedIds.has(action.id)) {
      throw new Error(
        `[prod-actions] duplicate PROD_ACTIONS entry "${action.id}" — the ordered array would render it twice in the operator panel and Apply-all would execute it twice`,
      );
    }
    orderedIds.add(action.id);
    const owned = owner.get(action.id);
    if (owned === undefined) {
      throw new Error(
        `[prod-actions] PROD_ACTIONS entry "${action.id}" is not owned by any registered domain — add it to its domain module's collection`,
      );
    }
    if (owned.action !== action) {
      throw new Error(
        `[prod-actions] PROD_ACTIONS entry "${action.id}" is not the object registered by domain "${owned.domainName}" — the ordered array must reference the domain-owned action instance, not a copy or substitute sharing its id`,
      );
    }
  }
  for (const [id, { domainName }] of owner) {
    if (!orderedIds.has(id)) {
      throw new Error(
        `[prod-actions] action "${id}" from domain "${domainName}" is missing from the ordered PROD_ACTIONS array — the composition root must list every domain action explicitly`,
      );
    }
  }
}
