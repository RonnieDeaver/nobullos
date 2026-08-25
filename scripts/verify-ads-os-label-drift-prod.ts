/**
 * Task #4966 — Prod-replica evidence check for the Ads OS monitor-label
 * drift guard (Task #4964).
 *
 * Queries `notification_health_state`, `user_notifications`, and
 * `notification_deliveries` to confirm five invariants:
 *
 *   1. Singleton present — the guard's durable health-state row exists and
 *      carries a recent `lastEvaluatedAt` timestamp.
 *   2. Alert fired — bell rows exist in `user_notifications` for at least
 *      one (ET day, zero-label account) pair in the window.
 *   3. Intra-day dedup clean — at most ONE bell row per
 *      (day, customer_id, user_id) triple; 15-min re-ticks did not spam.
 *   4. Daily re-fire — bell rows span ≥ 2 distinct ET days (confirmed only
 *      after at least two days of operation with a persistent condition).
 *   5. Quiet after repair — when `--repair-day YYYY-MM-DD` is supplied,
 *      confirms (a) the health-state transitioned to "healthy" on or after
 *      that date and (b) no bell rows exist for that day or any later day.
 *
 * Verdict semantics:
 *   PASS    — all required invariants hold.
 *   PENDING — health-state exists but not enough elapsed time/data to
 *             verify alert-fire or daily re-fire (run again tomorrow).
 *   FAIL    — at least one invariant is definitively broken.
 *
 * Read-only — safe to run against the production DB or prod-replica at any
 * time.  Set DATABASE_URL / PGHOST to the replica connection string if
 * running outside the deployed environment.
 *
 * Usage:
 *   tsx scripts/verify-ads-os-label-drift-prod.ts
 *   tsx scripts/verify-ads-os-label-drift-prod.ts --since 2026-08-01
 *   tsx scripts/verify-ads-os-label-drift-prod.ts --days 7
 *   tsx scripts/verify-ads-os-label-drift-prod.ts --repair-day 2026-08-20
 *     (verify quiet-after-repair starting from 2026-08-20 inclusive)
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  LABEL_DRIFT_NOTIFICATION_ID,
  LABEL_DRIFT_STATE_DEDUPE_KEY,
  LABEL_DRIFT_INBOX_DEDUPE_PREFIX,
} from "../server/services/adsOs/labelDriftGuard";

// ── CLI args ──────────────────────────────────────────────────────────────
interface Args {
  since: string | null;
  days: number;
  repairDay: string | null; // YYYY-MM-DD inclusive: state must be healthy from here, no bells
}

function parseArgs(argv: string[]): Args {
  let since: string | null = null;
  let days = 30;
  let repairDay: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--since" && argv[i + 1]) {
      since = argv[++i];
    } else if (argv[i] === "--days" && argv[i + 1]) {
      days = parseInt(argv[++i], 10);
    } else if (argv[i] === "--repair-day" && argv[i + 1]) {
      repairDay = argv[++i];
    }
  }
  return { since, days, repairDay };
}

// ── DB helpers ────────────────────────────────────────────────────────────
async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as T[];
  const maybeRows = (result as { rows?: T[] }).rows;
  return Array.isArray(maybeRows) ? maybeRows : [];
}

interface HealthStateRow {
  state: string;
  failure_type: string | null;
  last_notified_at: string | null;
  occurrence_count: number;
  metadata_json: unknown;
  transitioned_at: string;
}

interface BellCountRow {
  et_day: string;
  customer_id: string;
  recipient_count: number | string;
  dedupe_keys: string;
}

interface DedupeDriftRow {
  et_day: string;
  customer_id: string;
  user_id: string;
  bell_count: number | string;
}

interface DayCountRow {
  et_day: string;
  total_bells: number | string;
}

interface DeliveryRow {
  status: string;
  count: number | string;
  sample_key: string;
}

interface BellsAfterRow {
  count: number | string;
  first_day: string;
}

// ── Format helpers ────────────────────────────────────────────────────────
function fmt(val: string | null | undefined): string {
  return val ? new Date(val).toISOString() : "—";
}
function n(val: number | string | null | undefined): number {
  return Number(val ?? 0);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const windowStart = args.since ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - args.days);
    return d.toISOString().slice(0, 10);
  })();

  const prefix = LABEL_DRIFT_INBOX_DEDUPE_PREFIX; // "ads_os.label_drift:"

  console.log(
    `\n[VerifyLabelDrift] notification_id: ${LABEL_DRIFT_NOTIFICATION_ID}`,
  );
  console.log(
    `[VerifyLabelDrift] dedupe_key prefix: ${prefix}`,
  );
  console.log(
    `[VerifyLabelDrift] window: ${windowStart} → now` +
      (args.repairDay ? `  repair-day: ${args.repairDay}` : "") +
      "\n",
  );

  // Outcomes collected for final verdict
  let singletonOk = false;
  let alertFireOk: boolean | "pending" = "pending"; // pending until bell evidence found
  let dedupOk = false;
  let dailyRefireOk: boolean | "pending" = "pending";
  let repairOk: boolean | "n/a" = "n/a";

  // ── 1. Health-state singleton ─────────────────────────────────────────
  // PASS criterion: the row exists AND metadata_json.completedDay or
  // lastEvaluatedAt is set, proving at least one full evaluation pass ran.
  // (The guard writes completedDay only after a complete pass and refreshes
  // lastEvaluatedAt on every fully observed tick, including a same-day
  // short-circuit.) Freshness is shown here as operational evidence; the
  // independent watchdog pages responsible admins once it reaches 30 minutes.
  const healthRows = await rows<HealthStateRow>(sql`
    SELECT
      state,
      failure_type,
      last_notified_at,
      occurrence_count,
      metadata_json,
      transitioned_at
    FROM notification_health_state
    WHERE notification_id = ${LABEL_DRIFT_NOTIFICATION_ID}
      AND dedupe_key      = ${LABEL_DRIFT_STATE_DEDUPE_KEY}
    LIMIT 1
  `);

  console.log("── 1. Health-state singleton ────────────────────────────────");
  if (healthRows.length === 0) {
    singletonOk = false;
    console.log(
      "  ❌  FAIL — singleton NOT FOUND in notification_health_state.\n" +
      "    The drift guard has not completed a single pass yet.\n" +
      "    → Check deployment logs for '[adsOsLabelDrift]' boot lines.\n" +
      "    → Confirm WORKER_STAGGER_OFFSETS.ads_os_label_drift (~18 min) has elapsed.\n",
    );
  } else {
    const h = healthRows[0];
    const meta = (h.metadata_json ?? {}) as Record<string, unknown>;
    const hasFullPass =
      typeof meta.completedDay === "string" || typeof meta.lastEvaluatedAt === "string";
    singletonOk = hasFullPass;

    const lastEval = meta.lastEvaluatedAt as string | undefined;
    const ageMs =
      lastEval && !isNaN(new Date(lastEval).getTime())
        ? Date.now() - new Date(lastEval).getTime()
        : null;
    const ageFmt =
      ageMs === null ? "—"
      : ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s ago`
      : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago`
      : `${(ageMs / 3_600_000).toFixed(1)}h ago`;

    console.log(`  state:             ${h.state}`);
    console.log(`  failure_type:      ${h.failure_type ?? "—"}`);
    console.log(`  transitioned_at:   ${fmt(h.transitioned_at)}`);
    console.log(`  last_notified_at:  ${fmt(h.last_notified_at)}`);
    console.log(`  occurrence_count:  ${h.occurrence_count}`);
    console.log(`  completedDay:      ${meta.completedDay ?? "—"}`);
    console.log(`  ledgerDay:         ${meta.ledgerDay ?? "—"}`);
    console.log(`  zeroLabelCids:     ${JSON.stringify(meta.zeroLabelCids ?? [])}`);
    console.log(`  unknownCount:      ${meta.unknownCount ?? 0}`);
    console.log(`  lastEvaluatedAt:   ${meta.lastEvaluatedAt ?? "—"}  (${ageFmt})`);

    if (!hasFullPass) {
      console.log(
        "  ❌  FAIL — singleton exists but no completedDay or lastEvaluatedAt set.\n" +
        "    The guard has not yet completed a full evaluation pass.",
      );
    } else {
      // Informational here because this script's first invariant is historical
      // full-pass evidence. The independent runtime watchdog owns paging.
      if (ageMs !== null && ageMs > 35 * 60_000) {
        console.log(
          `  ⚠️   lastEvaluatedAt is ${ageFmt} old. This is not expected: healthy\n` +
          "    same-day short-circuits refresh the heartbeat. Confirm the staleness\n" +
          "    watchdog bell fired, then check deployment logs and the Ads API.",
        );
      }
      console.log("  ✅  Singleton present with full-pass evidence.");
    }
  }
  console.log();

  // ── 2. Bell rows by ET day + account ──────────────────────────────────
  const bellByDay = await rows<BellCountRow>(sql`
    SELECT
      substring(dedupe_key FROM ${prefix.length + 1} FOR 10)    AS et_day,
      split_part(dedupe_key, ':', 3)                             AS customer_id,
      COUNT(DISTINCT user_id)::int                               AS recipient_count,
      string_agg(dedupe_key, ', ' ORDER BY dedupe_key)           AS dedupe_keys
    FROM user_notifications
    WHERE dedupe_key LIKE ${`${prefix}%`}
      AND created_at  >= ${windowStart}::timestamptz
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `);

  console.log("── 2. Bell rows by (ET day, account) ───────────────────────");
  if (bellByDay.length === 0) {
    // Could be healthy (no zero-label accounts) or guard has not fired yet.
    alertFireOk = "pending";
    console.log(
      "  ⚠️   No bell rows in the window — PENDING.\n" +
      "    Possible causes:\n" +
      "    • All accounts are fully labeled (healthy): expected, guard goes quiet.\n" +
      "    • Guard has not yet completed a pass: check singleton timestamp above.\n" +
      "    • Kill switch 'ads_os_label_drift_guard_enabled' may be '0'/'false'.\n" +
      "    • getResponsibleAdminsForAlert() returned empty: no configured recipients.\n" +
      "    Re-run after the next 15-min tick if accounts are known to be zero-label.\n",
    );
  } else {
    alertFireOk = true;
    for (const r of bellByDay) {
      console.log(
        `  ✅  day=${r.et_day}  cid=${r.customer_id}  recipients=${n(r.recipient_count)}`,
      );
    }
  }
  console.log();

  // ── 3. Intra-day dedup check ──────────────────────────────────────────
  const dupRows = await rows<DedupeDriftRow>(sql`
    SELECT
      substring(dedupe_key FROM ${prefix.length + 1} FOR 10)    AS et_day,
      split_part(dedupe_key, ':', 3)                             AS customer_id,
      user_id,
      COUNT(*)::int                                              AS bell_count
    FROM user_notifications
    WHERE dedupe_key LIKE ${`${prefix}%`}
      AND created_at  >= ${windowStart}::timestamptz
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
    ORDER BY 1 DESC, 2 ASC, 3 ASC
  `);

  console.log("── 3. Intra-day dedup check (expect: zero rows) ─────────────");
  if (dupRows.length === 0) {
    dedupOk = true;
    console.log(
      "  ✅  No (day, account, user) triple has more than one bell row — no intra-day spam.",
    );
  } else {
    dedupOk = false;
    console.log(
      `  ❌  FAIL — ${dupRows.length} triple(s) with duplicate bell rows (intra-day spam):`,
    );
    for (const r of dupRows) {
      console.log(
        `    day=${r.et_day}  cid=${r.customer_id}  uid=${r.user_id}  count=${n(r.bell_count)}`,
      );
    }
    console.log(
      "  → The completedDay stamp in notification_health_state.metadata_json\n" +
      "    may not be persisting correctly. Inspect metadata_json directly.",
    );
  }
  console.log();

  // ── 4. Daily re-fire check ────────────────────────────────────────────
  const dayRows = await rows<DayCountRow>(sql`
    SELECT
      substring(dedupe_key FROM ${prefix.length + 1} FOR 10)    AS et_day,
      COUNT(*)::int                                              AS total_bells
    FROM user_notifications
    WHERE dedupe_key LIKE ${`${prefix}%`}
      AND created_at  >= ${windowStart}::timestamptz
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  console.log("── 4. Daily re-fire cadence ─────────────────────────────────");
  if (dayRows.length === 0) {
    dailyRefireOk = "pending";
    console.log("  —  No days with alerts in the window (see check 2).");
  } else if (dayRows.length === 1) {
    dailyRefireOk = "pending";
    console.log(`  ⚠️   Only 1 distinct ET day (${dayRows[0].et_day}) — re-fire PENDING.`);
    console.log("    Re-run this script tomorrow after the condition persists.");
  } else {
    dailyRefireOk = true;
    for (const r of dayRows) {
      console.log(`  ET day ${r.et_day}: ${n(r.total_bells)} bell row(s)`);
    }
    console.log(
      `  ✅  Alert re-fired across ${dayRows.length} distinct ET day(s) — daily cadence confirmed.`,
    );
  }
  console.log();

  // ── 5. Delivery channel outcomes ─────────────────────────────────────
  const deliveryRows = await rows<DeliveryRow>(sql`
    SELECT
      d.status,
      COUNT(*)::int          AS count,
      MIN(d.dedupe_key)      AS sample_key
    FROM notification_deliveries d
    WHERE d.dedupe_key LIKE ${`${prefix}%`}
      AND d.created_at >= ${windowStart}::timestamptz
    GROUP BY d.status
    ORDER BY d.status ASC
  `);

  console.log("── 5. Delivery channel outcomes (notification_deliveries) ────");
  if (deliveryRows.length === 0) {
    console.log(
      "  —  No notification_deliveries rows (no channel configured for recipients,\n" +
      "     or no bell rows in the window — see check 2).",
    );
  } else {
    for (const r of deliveryRows) {
      const ok = r.status === "delivered" || r.status === "skipped_deduped" ||
                 r.status === "skipped_no_channel";
      console.log(
        `  ${ok ? "✅" : "⚠️ "} status=${r.status}  count=${n(r.count)}  sample=${r.sample_key}`,
      );
    }
  }
  console.log();

  // ── 6. Quiet-after-repair check (only when --repair-day is supplied) ──
  //
  // The repair action runs on the same ET day the alert fired, so a
  // pre-repair bell necessarily exists on repair-day.  We therefore:
  //   (a) Require health-state.state = "healthy" with transitioned_at on or
  //       after the ET calendar date of repair-day (DST-safe: compared via
  //       Postgres AT TIME ZONE 'America/New_York').
  //   (b) Require ZERO bell rows whose embedded ET day (the YYYY-MM-DD
  //       segment of the dedupe key) is STRICTLY AFTER repair-day.
  //       Comparing the key-embedded date string avoids all UTC-offset /
  //       DST arithmetic — the guard itself writes the ET date using
  //       Intl.DateTimeFormat(America/New_York), so the key is authoritative.
  if (args.repairDay) {
    const rd = args.repairDay; // YYYY-MM-DD (ET calendar date)

    console.log(
      `── 6. Quiet after repair (--repair-day ${rd}, no-bell from ET day > ${rd}) ──`,
    );

    if (healthRows.length === 0) {
      repairOk = false;
      console.log("  ❌  FAIL — singleton missing, cannot verify repair transition.");
    } else {
      const h = healthRows[0];

      // (a) State must be "healthy" AND transitioned_at falls on or after the
      //     ET calendar date of repair-day.  Use Postgres timezone conversion so
      //     DST is handled by the database, not by Node fixed-offset arithmetic.
      const transitionCheckRows = await rows<{ ok: boolean }>(sql`
        SELECT (
          ${h.transitioned_at ?? null}::timestamptz IS NOT NULL
          AND (${h.transitioned_at ?? null}::timestamptz AT TIME ZONE 'America/New_York')::date
              >= ${rd}::date
        ) AS ok
      `);
      const transitionedAfterEt = transitionCheckRows[0]?.ok === true;
      const stateHealthy = h.state === "healthy";

      let subAOk = true;
      if (stateHealthy && transitionedAfterEt) {
        console.log(
          `  ✅  (a) State is "healthy", transitioned at ${fmt(h.transitioned_at)} ` +
            `(ET date on or after ${rd}).`,
        );
      } else {
        subAOk = false;
        repairOk = false;
        if (!stateHealthy) {
          console.log(
            `  ❌  FAIL (a) — state is "${h.state}", expected "healthy" after repair.`,
          );
        } else {
          console.log(
            `  ❌  FAIL (a) — state is "healthy" but transitioned_at ` +
              `${fmt(h.transitioned_at)} falls before ET date ${rd}.`,
          );
        }
      }

      // (b) No bell rows whose embedded ET day (key segment) is strictly after
      //     repair-day.  String comparison on YYYY-MM-DD is lexicographically
      //     correct and inherently DST-safe (the key already encodes ET date).
      const bellsAfterRows = await rows<BellsAfterRow>(sql`
        SELECT
          COUNT(*)::int                                                  AS count,
          MIN(substring(dedupe_key FROM ${prefix.length + 1} FOR 10))   AS first_day
        FROM user_notifications
        WHERE dedupe_key LIKE ${`${prefix}%`}
          AND substring(dedupe_key FROM ${prefix.length + 1} FOR 10) > ${rd}
      `);

      const bellsAfter = n(bellsAfterRows[0]?.count ?? 0);
      const firstDayAfter = bellsAfterRows[0]?.first_day ?? "—";

      if (bellsAfter === 0) {
        console.log(
          `  ✅  (b) No bell rows with ET day > ${rd} — guard went quiet after repair.`,
        );
        if (repairOk !== false) repairOk = subAOk;
      } else {
        repairOk = false;
        console.log(
          `  ❌  FAIL (b) — ${bellsAfter} bell row(s) with ET day > ${rd}\n` +
            `    (earliest day: ${firstDayAfter}).\n` +
            "    Either the repair did not fix all zero-label accounts, or new\n" +
            "    accounts have drifted back to zero after the repair.",
        );
      }
    }
    console.log();
  }

  // ── Final verdict ─────────────────────────────────────────────────────
  console.log("── Final verdict ────────────────────────────────────────────");
  console.log(`  [1] Singleton present:        ${singletonOk ? "✅  PASS" : "❌  FAIL"}`);
  console.log(
    `  [2] Alert fired:              ${
      alertFireOk === true ? "✅  PASS"
      : alertFireOk === "pending" ? "⏳  PENDING (no bell rows yet — see above)"
      : "❌  FAIL"
    }`,
  );
  console.log(`  [3] Intra-day dedup clean:    ${dedupOk ? "✅  PASS" : "❌  FAIL"}`);
  console.log(
    `  [4] Daily re-fire:            ${
      dailyRefireOk === true ? "✅  PASS"
      : dailyRefireOk === "pending" ? "⏳  PENDING (< 2 distinct days — run tomorrow)"
      : "❌  FAIL"
    }`,
  );
  if (args.repairDay) {
    console.log(
      `  [5] Quiet after repair:       ${
        repairOk === true ? "✅  PASS"
        : repairOk === "n/a" ? "—   N/A (no --repair-day supplied)"
        : "❌  FAIL"
      }`,
    );
  }

  const anyFail = !singletonOk || alertFireOk === false || !dedupOk ||
    dailyRefireOk === false || repairOk === false;
  const anyPending = !anyFail &&
    (alertFireOk === "pending" || dailyRefireOk === "pending");

  const verdict = anyFail ? "❌  FAIL" : anyPending ? "⏳  PENDING" : "✅  PASS";
  console.log(`\n  Overall: ${verdict}`);

  if (anyPending) {
    console.log(
      "  Re-run this script tomorrow (or after the next tick) to confirm\n" +
      "  alert-fire and daily re-fire once production data has accumulated.\n",
    );
  } else if (!anyFail) {
    console.log(
      "  All invariants confirmed. The drift guard is wired correctly.\n",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[VerifyLabelDrift] Unexpected error:", err);
    process.exit(1);
  },
);
