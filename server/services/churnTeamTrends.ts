/**
 * Task #3712 — per-AM churn trend aggregation for the Team Coaching tab.
 *
 * Deterministic reads only, following the leaderboard aggregation approach
 * (server/routes/churn.ts): one pass over active (non-archived, non-demo)
 * clients joining the latest daily judgment, 7/30-day risk baselines and
 * 30-day communication counts, plus a second pass exploding complaint
 * themes out of client_communication_insights (the per-communication
 * enrichment output — client_relationship_signals.topComplaintThemes is
 * never populated, so insights are the real source). Rows are then bucketed
 * by clients.owner_id in JS into per-AM entries, an "unassigned" bucket
 * (owner_id IS NULL — ownerless books are never silently dropped) and a
 * department-wide rollup over every active client.
 *
 * Takes the caller's db handle like openAsksRollup does — routes pass the
 * request-scoped API pool.
 */
import { sql } from "drizzle-orm";

export interface TeamTrendTheme {
  category: string;
  mentions: number;
  clientCount: number;
  weight: number;
}

export interface TeamTrendStatusMix {
  healthy: number;
  watch: number;
  atRisk: number;
  critical: number;
  noData: number;
}

export interface TeamTrendBucket {
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerAvatar: string | null;
  unassigned: boolean;
  clientCount: number;
  statusMix: TeamTrendStatusMix;
  avgRisk: number | null;
  scoredClients: number;
  riskDelta7d: number | null;
  riskDelta30d: number | null;
  delta7Count: number;
  delta30Count: number;
  comms: { total: number; zoom: number; email: number };
  topThemes: TeamTrendTheme[];
}

export interface TeamTrendsResponse {
  managers: TeamTrendBucket[];
  department: Omit<
    TeamTrendBucket,
    "ownerId" | "ownerName" | "ownerEmail" | "ownerAvatar" | "unassigned"
  > & { managerCount: number };
  generatedAt: string;
}

type DbConn = { execute(query: unknown): Promise<unknown> };

const COMMS_WINDOW_DAYS = 30;
const THEME_WINDOW_DAYS = 30;
const TOP_THEMES_PER_BUCKET = 5;

function toNum(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function emptyMix(): TeamTrendStatusMix {
  return { healthy: 0, watch: 0, atRisk: 0, critical: 0, noData: 0 };
}

function bumpMix(mix: TeamTrendStatusMix, status: string | null | undefined): void {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "healthy") mix.healthy += 1;
  else if (s === "watch") mix.watch += 1;
  else if (s === "at risk") mix.atRisk += 1;
  else if (s === "critical") mix.critical += 1;
  // Unknown/legacy statuses count as noData rather than inventing a bucket.
  else mix.noData += 1;
}

interface MutableBucket {
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerAvatar: string | null;
  clientCount: number;
  statusMix: TeamTrendStatusMix;
  riskSum: number;
  scoredClients: number;
  delta7Sum: number;
  delta7Count: number;
  delta30Sum: number;
  delta30Count: number;
  comms: { total: number; zoom: number; email: number };
  themes: Map<string, TeamTrendTheme>;
}

function newBucket(row?: {
  owner_id?: unknown;
  owner_first_name?: unknown;
  owner_last_name?: unknown;
  owner_email?: unknown;
  owner_avatar?: unknown;
}): MutableBucket {
  const ownerId = (row?.owner_id ?? null) as string | null;
  const ownerName = ownerId
    ? [row?.owner_first_name, row?.owner_last_name].filter(Boolean).join(" ") ||
      ((row?.owner_email as string | null) ?? null)
    : null;
  return {
    ownerId,
    ownerName,
    ownerEmail: ownerId ? ((row?.owner_email as string | null) ?? null) : null,
    ownerAvatar: ownerId ? ((row?.owner_avatar as string | null) ?? null) : null,
    clientCount: 0,
    statusMix: emptyMix(),
    riskSum: 0,
    scoredClients: 0,
    delta7Sum: 0,
    delta7Count: 0,
    delta30Sum: 0,
    delta30Count: 0,
    comms: { total: 0, zoom: 0, email: 0 },
    themes: new Map(),
  };
}

function finalizeThemes(themes: Map<string, TeamTrendTheme>): TeamTrendTheme[] {
  return [...themes.values()]
    .sort((a, b) => b.weight - a.weight || b.mentions - a.mentions)
    .slice(0, TOP_THEMES_PER_BUCKET)
    .map((t) => ({ ...t, weight: round1(t.weight) }));
}

function finalizeBucket(b: MutableBucket, unassigned: boolean): TeamTrendBucket {
  return {
    ownerId: b.ownerId,
    ownerName: unassigned ? "Unassigned" : b.ownerName,
    ownerEmail: b.ownerEmail,
    ownerAvatar: b.ownerAvatar,
    unassigned,
    clientCount: b.clientCount,
    statusMix: b.statusMix,
    avgRisk: b.scoredClients > 0 ? round1(b.riskSum / b.scoredClients) : null,
    scoredClients: b.scoredClients,
    riskDelta7d: b.delta7Count > 0 ? round1(b.delta7Sum / b.delta7Count) : null,
    riskDelta30d: b.delta30Count > 0 ? round1(b.delta30Sum / b.delta30Count) : null,
    delta7Count: b.delta7Count,
    delta30Count: b.delta30Count,
    comms: b.comms,
    topThemes: finalizeThemes(b.themes),
  };
}

export async function fetchTeamTrends(db: DbConn): Promise<TeamTrendsResponse> {
  // Pass 1 — per-client core row: owner, latest judgment, risk baselines,
  // 30-day comm counts. Same CTE idioms (varchar judgment_date + ISO-shape
  // regex guards) as the leaderboard query.
  const coreResult = await db.execute(sql`
    WITH active_clients AS (
      SELECT c.id, c.owner_id,
             u.first_name AS owner_first_name,
             u.last_name  AS owner_last_name,
             u.email      AS owner_email,
             u.profile_image_url AS owner_avatar
      FROM clients c
      LEFT JOIN users u ON u.id = c.owner_id
      WHERE COALESCE(c.is_archived, false) = false
        AND COALESCE(c.is_demo, false) = false
    ),
    latest_judgment AS (
      SELECT DISTINCT ON (j.client_id)
             j.client_id, j.status, j.risk_score, j.judgment_date
      FROM client_daily_judgments j
      WHERE j.client_id IN (SELECT id FROM active_clients)
      ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
    ),
    baseline_7d AS (
      SELECT DISTINCT ON (j.client_id) j.client_id, j.risk_score
      FROM client_daily_judgments j
      JOIN latest_judgment l ON l.client_id = j.client_id
      WHERE j.risk_score IS NOT NULL
        AND j.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND l.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND j.judgment_date::date <= l.judgment_date::date - 7
      ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
    ),
    baseline_30d AS (
      SELECT DISTINCT ON (j.client_id) j.client_id, j.risk_score
      FROM client_daily_judgments j
      JOIN latest_judgment l ON l.client_id = j.client_id
      WHERE j.risk_score IS NOT NULL
        AND j.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND l.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND j.judgment_date::date <= l.judgment_date::date - 30
      ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
    ),
    comm_counts AS (
      SELECT r.client_id,
             COUNT(*)::int AS total_comms,
             COUNT(*) FILTER (WHERE r.source_type = 'zoom')::int AS zoom_comms,
             COUNT(*) FILTER (WHERE r.source_type = 'front_email')::int AS email_comms
      FROM raw_communication_records r
      WHERE r.client_id IN (SELECT id FROM active_clients)
        AND r.timestamp >= NOW() - make_interval(days => ${COMMS_WINDOW_DAYS})
      GROUP BY r.client_id
    )
    SELECT a.id, a.owner_id, a.owner_first_name, a.owner_last_name,
           a.owner_email, a.owner_avatar,
           l.status, l.risk_score, l.judgment_date,
           b7.risk_score  AS baseline_risk_7d,
           b30.risk_score AS baseline_risk_30d,
           COALESCE(cc.total_comms, 0) AS total_comms,
           COALESCE(cc.zoom_comms, 0)  AS zoom_comms,
           COALESCE(cc.email_comms, 0) AS email_comms
    FROM active_clients a
    LEFT JOIN latest_judgment l ON l.client_id = a.id
    LEFT JOIN baseline_7d  b7  ON b7.client_id  = a.id
    LEFT JOIN baseline_30d b30 ON b30.client_id = a.id
    LEFT JOIN comm_counts  cc  ON cc.client_id  = a.id
  `);

  // Pass 2 — complaint themes from per-communication enrichment insights,
  // windowed by the underlying communication's timestamp. severity is
  // regex-guarded before the ::real cast so a non-numeric legacy value
  // degrades to the 0.5 default instead of a 500.
  const themeResult = await db.execute(sql`
    SELECT c.owner_id,
           t.value->>'category' AS category,
           COUNT(*)::int AS mentions,
           COUNT(DISTINCT i.client_id)::int AS client_count,
           SUM(
             CASE WHEN COALESCE(t.value->>'severity', '') ~ '^[0-9]*\\.?[0-9]+$'
                  THEN (t.value->>'severity')::real
                  ELSE 0.5 END
           )::real AS weight
    FROM client_communication_insights i
    JOIN clients c ON c.id = i.client_id
    JOIN raw_communication_records r ON r.id = i.raw_communication_record_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(i.complaint_themes) = 'array'
           THEN i.complaint_themes ELSE '[]'::jsonb END
    ) AS t(value)
    WHERE COALESCE(c.is_archived, false) = false
      AND COALESCE(c.is_demo, false) = false
      AND r.timestamp >= NOW() - make_interval(days => ${THEME_WINDOW_DAYS})
      AND COALESCE(t.value->>'category', '') <> ''
    GROUP BY c.owner_id, t.value->>'category'
  `);

  const coreRows: any[] = (coreResult as any).rows ?? [];
  const themeRows: any[] = (themeResult as any).rows ?? [];

  const buckets = new Map<string, MutableBucket>();
  const bucketKey = (ownerId: string | null) => ownerId ?? "__unassigned__";
  const department = newBucket();

  for (const row of coreRows) {
    const key = bucketKey((row.owner_id ?? null) as string | null);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = newBucket(row);
      buckets.set(key, bucket);
    }

    const riskScore = toNum(row.risk_score);
    const base7 = toNum(row.baseline_risk_7d);
    const base30 = toNum(row.baseline_risk_30d);
    const hasJudgment = row.judgment_date !== null && row.judgment_date !== undefined;

    for (const b of [bucket, department]) {
      b.clientCount += 1;
      bumpMix(b.statusMix, hasJudgment ? (row.status as string) : null);
      if (riskScore !== null) {
        b.riskSum += riskScore;
        b.scoredClients += 1;
        if (base7 !== null) {
          b.delta7Sum += riskScore - base7;
          b.delta7Count += 1;
        }
        if (base30 !== null) {
          b.delta30Sum += riskScore - base30;
          b.delta30Count += 1;
        }
      }
      b.comms.total += Number(row.total_comms ?? 0);
      b.comms.zoom += Number(row.zoom_comms ?? 0);
      b.comms.email += Number(row.email_comms ?? 0);
    }
  }

  for (const row of themeRows) {
    const key = bucketKey((row.owner_id ?? null) as string | null);
    const bucket = buckets.get(key);
    const category = String(row.category);
    const mentions = Number(row.mentions ?? 0);
    const clientCount = Number(row.client_count ?? 0);
    const weight = Number(row.weight ?? 0);
    for (const b of [bucket, department]) {
      if (!b) continue; // theme for a client whose owner bucket has no core row (shouldn't happen)
      const existing = b.themes.get(category);
      if (existing) {
        existing.mentions += mentions;
        existing.clientCount += clientCount;
        existing.weight += weight;
      } else {
        b.themes.set(category, { category, mentions, clientCount, weight });
      }
    }
  }

  const managers: TeamTrendBucket[] = [];
  let unassignedBucket: TeamTrendBucket | null = null;
  for (const [key, bucket] of buckets) {
    const finalized = finalizeBucket(bucket, key === "__unassigned__");
    if (finalized.unassigned) unassignedBucket = finalized;
    else managers.push(finalized);
  }
  managers.sort((a, b) => {
    const ar = a.avgRisk ?? -1;
    const br = b.avgRisk ?? -1;
    return br - ar || (a.ownerName ?? "").localeCompare(b.ownerName ?? "");
  });
  // Unassigned bucket always LAST so it's visible but never ranked above AMs.
  if (unassignedBucket) managers.push(unassignedBucket);

  const dept = finalizeBucket(department, false);
  return {
    managers,
    department: {
      clientCount: dept.clientCount,
      statusMix: dept.statusMix,
      avgRisk: dept.avgRisk,
      scoredClients: dept.scoredClients,
      riskDelta7d: dept.riskDelta7d,
      riskDelta30d: dept.riskDelta30d,
      delta7Count: dept.delta7Count,
      delta30Count: dept.delta30Count,
      comms: dept.comms,
      topThemes: dept.topThemes,
      managerCount: managers.filter((m) => !m.unassigned).length,
    },
    generatedAt: new Date().toISOString(),
  };
}
