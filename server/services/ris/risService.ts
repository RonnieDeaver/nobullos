// @db-pool-intent: ambient
//
// Task #2367 — RIS rollup + applicable-instance computation. Rollups are
// computed on read (no materialized rollup table) which satisfies the
// "lightweight rollup concept" for V1's manual volume.
//
// An "instance" is one checklist row a human acts on: a catalog check
// expanded per applicable location. Product applicability is derived from
// the client's product list (normalizeProductList) — `universal` checks
// apply to every client; product-scoped checks only when the client
// carries that product.

import { normalizeProductList } from "../../utils/productResolution";
import {
  getActiveClients,
  getClient,
  getClientLocations,
  getUser,
} from "../../storage/clientStorage";
import {
  listRisChecks,
  getRisResultsForClient,
  getRisResultsForPeriods,
} from "../../storage/risStorage";
import {
  risSeverities,
  type RisCheck,
  type RisCheckResult,
  type RisSeverity,
  type RisStatus,
  type RisPerformanceStatus,
} from "@shared/schema";
import type { Client, ClientLocation } from "@shared/schema";
import {
  getCommunicationCadence,
  type CommunicationCadence,
} from "./risCadence";
import { COMM_CADENCE_AUTO_SOURCE } from "./risCatalog";

export const LAUNCH_PERIOD = "launch";

/** Current calendar month key `YYYY-MM` (server local time). */
export function currentPeriod(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const SEVERITY_RANK: Record<RisSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function rankSeverity(s: string | null | undefined): number {
  return SEVERITY_RANK[(s as RisSeverity)] ?? 0;
}

export type DueBucket = "week" | "month" | "launch";

export interface ChecklistInstance {
  checkId: string;
  key: string;
  label: string;
  description: string | null;
  product: string;
  category: string;
  frequency: string;
  locationSpecific: boolean;
  autoSource: string | null;
  defaultSeverity: string;
  effectiveSeverity: string;
  defaultOwnerFunction: string | null;
  locationId: string | null;
  locationName: string | null;
  period: string;
  dueBucket: DueBucket;
  // Result fields (null when not yet checked).
  resultId: string | null;
  status: RisStatus | null;
  observedValue: string | null;
  notes: string | null;
  evidenceUrl: string | null;
  failureReason: string | null;
  correctiveAction: string | null;
  source: string | null;
  checkedBy: string | null;
  checkedByName: string | null;
  checkedAt: Date | null;
  // Task #2368 — auto-pull provenance.
  autoError: string | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
  // Engagement layer (Task #2388): live auto-counted comms volume,
  // populated only for the check tagged with the comm-cadence auto-source
  // (check #7). Null on every other instance. Informational only — never
  // sets the human status.
  cadence?: CommunicationCadence | null;
}

export interface RisRollup {
  totalDue: number;
  completed: number;
  completionPct: number;
  pass: number;
  fail: number;
  na: number;
  blocked: number;
  needsReview: number;
  untouched: number;
  openFails: number;
  openBlocked: number;
  topSeverity: string | null;
  dueThisWeek: number;
  dueThisMonth: number;
  launchDue: number;
}

export interface ClientChecklist {
  client: Pick<Client, "id" | "firmName">;
  products: string[];
  locations: Pick<ClientLocation, "id" | "name">[];
  period: string;
  instances: ChecklistInstance[];
  rollup: RisRollup;
}

export interface ClientRollupSummary {
  clientId: string;
  firmName: string;
  products: string[];
  rollup: RisRollup;
}

export interface PortfolioRollup {
  period: string;
  clients: ClientRollupSummary[];
  totals: RisRollup;
}

function resultKey(
  checkId: string,
  locationId: string | null,
  period: string,
): string {
  return `${checkId}|${locationId ?? ""}|${period}`;
}

function applicableProducts(client: Client): string[] {
  return normalizeProductList(client.products ?? []);
}

/**
 * Launch-only checks must re-open when a client's scope changes. We key
 * their period to a signature of the current scope rather than a single
 * static sentinel: product-level launch checks hash the (sorted) product
 * mix + active-location-id set, so adding/removing a product or location
 * yields a new period and the previously-completed launch result no
 * longer matches (the check re-surfaces as untouched). Location-specific
 * launch checks instead key on the location id directly, so a newly added
 * location gets its own untouched instance while existing ones are kept.
 */
function launchScopeSignature(
  products: string[],
  locationIds: string[],
): string {
  const basis = JSON.stringify([
    [...products].sort(),
    [...locationIds].sort(),
  ]);
  let h = 5381;
  for (let i = 0; i < basis.length; i++) {
    h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Single source of truth for a launch-only check's period key. Both the
 * read path (expandInstances) and the write path (the result-save route,
 * via resolveLaunchPeriodForSave) MUST use this so a saved launch result
 * matches the rendered instance exactly. Location-specific launch checks
 * key on the location id; product-level ones key on the scope signature.
 */
export function launchPeriodFor(
  locationSpecific: boolean,
  locationId: string | null,
  products: string[],
  locationIds: string[],
): string {
  if (locationSpecific && locationId) {
    return `${LAUNCH_PERIOD}:loc:${locationId}`;
  }
  return `${LAUNCH_PERIOD}:${launchScopeSignature(products, locationIds)}`;
}

/**
 * Resolve the scoped launch period for a save by fetching the client's
 * current product mix + active locations, so the persisted period matches
 * exactly what expandInstances() will look up on read. Keeping this in the
 * service (not the route) prevents the write/read contract from drifting.
 */
export async function resolveLaunchPeriodForSave(
  clientId: string,
  locationSpecific: boolean,
  locationId: string | null,
): Promise<string> {
  const [client, locationsRaw] = await Promise.all([
    getClient(clientId),
    getClientLocations(clientId),
  ]);
  const products = client ? applicableProducts(client) : [];
  const locationIds = locationsRaw
    .filter((l) => l.isActive !== false)
    .map((l) => l.id);
  return launchPeriodFor(locationSpecific, locationId, products, locationIds);
}

/**
 * Expand the active catalog into the per-client checklist instances for a
 * period, joined to any existing results.
 */
function expandInstances(
  checks: RisCheck[],
  products: string[],
  locations: Pick<ClientLocation, "id" | "name">[],
  results: RisCheckResult[],
  monthPeriod: string,
  userNames: Map<string, string> = new Map(),
): ChecklistInstance[] {
  const byKey = new Map<string, RisCheckResult>();
  for (const r of results) {
    byKey.set(resultKey(r.checkId, r.locationId ?? null, r.period), r);
  }
  // Active location id set feeds the scope signature used to re-trigger
  // product-level launch checks on scope change (see launchPeriodFor).
  const locationIds = locations.map((l) => l.id);
  const instances: ChecklistInstance[] = [];
  for (const check of checks) {
    if (check.product !== "universal" && !products.includes(check.product)) {
      continue;
    }
    const isLaunch = check.frequency === "launch_only";
    const dueBucket: DueBucket = isLaunch
      ? "launch"
      : check.frequency === "weekly"
        ? "week"
        : "month";

    // Location-specific checks fan out per active location; if a client
    // has no locations the check still renders once (null location) so it
    // is not silently dropped.
    const scopes: (Pick<ClientLocation, "id" | "name"> | null)[] =
      check.locationSpecific && locations.length > 0 ? locations : [null];

    for (const loc of scopes) {
      const locId = loc?.id ?? null;
      // Launch checks key their period to the trigger scope so they re-open
      // on change; non-launch checks use the calendar month.
      const period = isLaunch
        ? launchPeriodFor(check.locationSpecific, locId, products, locationIds)
        : monthPeriod;
      const r = byKey.get(resultKey(check.id, locId, period));
      const effectiveSeverity =
        (r?.severityOverride as string | null) ?? check.defaultSeverity;
      instances.push({
        checkId: check.id,
        key: check.key,
        label: check.label,
        description: check.description ?? null,
        product: check.product,
        category: check.category,
        frequency: check.frequency,
        locationSpecific: check.locationSpecific,
        autoSource: check.autoSource ?? null,
        defaultSeverity: check.defaultSeverity,
        effectiveSeverity,
        defaultOwnerFunction: check.defaultOwnerFunction ?? null,
        locationId: locId,
        locationName: loc?.name ?? null,
        period,
        dueBucket,
        resultId: r?.id ?? null,
        status: (r?.status as RisStatus) ?? null,
        observedValue: r?.observedValue ?? null,
        notes: r?.notes ?? null,
        evidenceUrl: r?.evidenceUrl ?? null,
        failureReason: r?.failureReason ?? null,
        correctiveAction: r?.correctiveAction ?? null,
        source: r?.source ?? null,
        checkedBy: r?.checkedBy ?? null,
        checkedByName: r?.checkedBy ? userNames.get(r.checkedBy) ?? null : null,
        checkedAt: r?.checkedAt ?? null,
        autoError: r?.autoError ?? null,
        confirmedAt: r?.confirmedAt ?? null,
        confirmedBy: r?.confirmedBy ?? null,
        confirmedByName: r?.confirmedBy ? userNames.get(r.confirmedBy) ?? null : null,
      });
    }
  }
  return instances;
}

function rollup(instances: ChecklistInstance[]): RisRollup {
  let pass = 0,
    fail = 0,
    na = 0,
    blocked = 0,
    needsReview = 0,
    untouched = 0;
  let dueThisWeek = 0,
    dueThisMonth = 0,
    launchDue = 0;
  let topSeverity: string | null = null;

  for (const i of instances) {
    const s = i.status;
    if (!s) untouched++;
    else if (s === "pass") pass++;
    else if (s === "fail") fail++;
    else if (s === "na") na++;
    else if (s === "blocked") blocked++;
    else if (s === "needs_review") needsReview++;

    const resolved = s === "pass" || s === "na";
    if (i.dueBucket === "launch") {
      if (!resolved) launchDue++;
    } else {
      const done = s === "pass" || s === "fail" || s === "na" || s === "blocked";
      if (!done) {
        if (i.dueBucket === "week") dueThisWeek++;
        else dueThisMonth++;
      }
    }

    if (s === "fail" || s === "blocked") {
      if (
        topSeverity == null ||
        rankSeverity(i.effectiveSeverity) > rankSeverity(topSeverity)
      ) {
        topSeverity = i.effectiveSeverity;
      }
    }
  }

  const totalDue = instances.length;
  // Completion = any non-null status (matches RIS.md "Completion %"), i.e.
  // every instance the operator has actioned, including needs_review.
  const completed = pass + fail + na + blocked + needsReview;
  return {
    totalDue,
    completed,
    completionPct: totalDue === 0 ? 0 : Math.round((completed / totalDue) * 100),
    pass,
    fail,
    na,
    blocked,
    needsReview,
    untouched,
    openFails: fail,
    openBlocked: blocked,
    topSeverity,
    dueThisWeek,
    dueThisMonth,
    launchDue,
  };
}

export async function buildClientChecklist(
  clientId: string,
  monthPeriod: string,
  layer: string = "qa",
): Promise<ClientChecklist | null> {
  const client = await getClient(clientId);
  if (!client) return null;
  const [checks, locationsRaw] = await Promise.all([
    listRisChecks({ activeOnly: true, layer }),
    getClientLocations(clientId),
  ]);
  const locations = locationsRaw
    .filter((l) => l.isActive !== false)
    .map((l) => ({ id: l.id, name: l.name }));
  const products = applicableProducts(client);
  const results = await getRisResultsForClient(clientId, [
    monthPeriod,
    LAUNCH_PERIOD,
  ]);
  // Resolve display names for the distinct checkers so the row can show
  // "checked by <name>" rather than a raw user id.
  const checkerIds = Array.from(
    new Set(results.map((r) => r.checkedBy).filter((id): id is string => !!id)),
  );
  const userNames = new Map<string, string>();
  await Promise.all(
    checkerIds.map(async (id) => {
      const u = await getUser(id).catch(() => undefined);
      if (u) {
        const name =
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          u.email ||
          id;
        userNames.set(id, name);
      }
    }),
  );
  const instances = expandInstances(
    checks,
    products,
    locations,
    results,
    monthPeriod,
    userNames,
  );
  // Engagement layer (Task #2388): attach live comms volume to the
  // comm-cadence check (#7). Computed once and shared across any matching
  // instance (there is only one — it is universal + client-level). The
  // human still sets the status; this is purely informational.
  const cadenceInstances = instances.filter(
    (i) => i.autoSource === COMM_CADENCE_AUTO_SOURCE,
  );
  if (cadenceInstances.length > 0) {
    const cadence = await getCommunicationCadence(clientId, monthPeriod);
    for (const inst of cadenceInstances) inst.cadence = cadence;
  }
  return {
    client: { id: client.id, firmName: client.firmName },
    products,
    locations,
    period: monthPeriod,
    instances,
    rollup: rollup(instances),
  };
}

export async function buildPortfolioRollup(
  monthPeriod: string,
  layer: string = "qa",
): Promise<PortfolioRollup> {
  const [clients, checks, results] = await Promise.all([
    getActiveClients(),
    listRisChecks({ activeOnly: true, layer }),
    getRisResultsForPeriods([monthPeriod, LAUNCH_PERIOD]),
  ]);

  // Group results by client so each client computes from its own slice.
  const resultsByClient = new Map<string, RisCheckResult[]>();
  for (const r of results) {
    const arr = resultsByClient.get(r.clientId) ?? [];
    arr.push(r);
    resultsByClient.set(r.clientId, arr);
  }

  // Locations are needed only for clients carrying a location-specific
  // applicable check. Fetch them lazily and in parallel.
  const needsLocations = clients.map((c) => c.id);
  const locationLists = await Promise.all(
    needsLocations.map((id) => getClientLocations(id).catch(() => [])),
  );
  const locByClient = new Map<string, Pick<ClientLocation, "id" | "name">[]>();
  needsLocations.forEach((id, idx) => {
    locByClient.set(
      id,
      locationLists[idx]
        .filter((l) => l.isActive !== false)
        .map((l) => ({ id: l.id, name: l.name })),
    );
  });

  const summaries: ClientRollupSummary[] = [];
  const allInstances: ChecklistInstance[] = [];
  for (const client of clients) {
    const products = applicableProducts(client);
    const instances = expandInstances(
      checks,
      products,
      locByClient.get(client.id) ?? [],
      resultsByClient.get(client.id) ?? [],
      monthPeriod,
    );
    allInstances.push(...instances);
    summaries.push({
      clientId: client.id,
      firmName: client.firmName,
      products,
      rollup: rollup(instances),
    });
  }

  return {
    period: monthPeriod,
    clients: summaries,
    totals: rollup(allInstances),
  };
}

// ─── Task #2371 — Performance Layer rollups (Product Health Cards) ─────
//
// The Performance layer renders one "Product Health Card" per applicable
// product (a Universal summary card plus one per active product). Each card
// shows its metrics' color-coded statuses and rolls up to a single worst-of
// card status (Red dominates Yellow dominates Green; Gray/N-A do not count
// toward the worst-of). Statuses come straight from the stored Performance
// results (written by runRisPerformancePull); this read path never scores.

/** One scored Performance metric on a health card. */
export interface PerformanceMetric {
  checkId: string;
  key: string;
  label: string;
  description: string | null;
  product: string;
  category: string;
  metricType: string | null;
  defaultSeverity: string;
  effectiveSeverity: string;
  defaultOwnerFunction: string | null;
  period: string;
  // Result fields (null when not yet pulled).
  resultId: string | null;
  status: RisPerformanceStatus | null;
  observedValue: string | null;
  currentValue: string | null;
  previousValue: string | null;
  targetValue: string | null;
  changePct: string | null;
  notes: string | null;
  source: string | null;
  autoError: string | null;
  checkedAt: Date | null;
  confirmedAt: Date | null;
}

export interface PerformanceStatusCounts {
  green: number;
  yellow: number;
  red: number;
  gray: number;
  na: number;
}

/** A Product Health Card: a product's worst-of status + its metrics. */
export interface ProductHealthCard {
  product: string;
  status: RisPerformanceStatus;
  counts: PerformanceStatusCounts;
  topSeverity: string | null;
  metrics: PerformanceMetric[];
}

export interface ClientPerformance {
  client: Pick<Client, "id" | "firmName">;
  products: string[];
  period: string;
  cards: ProductHealthCard[];
}

export interface ClientPerformanceSummary {
  clientId: string;
  firmName: string;
  products: string[];
  status: RisPerformanceStatus;
  counts: PerformanceStatusCounts;
  topSeverity: string | null;
}

export interface PortfolioPerformance {
  period: string;
  clients: ClientPerformanceSummary[];
  totals: PerformanceStatusCounts;
}

const PERF_RANK: Record<string, number> = { green: 1, yellow: 2, red: 3 };

/** Worst-of across metric statuses: Red>Yellow>Green. Gray/N-A are ignored
 *  unless nothing else is present (then Gray, else N/A for an empty card). */
function worstPerformanceStatus(
  statuses: (RisPerformanceStatus | null)[],
): RisPerformanceStatus {
  let worst = 0;
  let sawGray = false;
  let sawAny = false;
  for (const s of statuses) {
    if (!s) continue;
    sawAny = true;
    if (s === "gray") sawGray = true;
    else if (s === "na") {
      /* N/A does not contribute to worst-of */
    } else {
      const r = PERF_RANK[s] ?? 0;
      if (r > worst) worst = r;
    }
  }
  if (worst === 3) return "red";
  if (worst === 2) return "yellow";
  if (worst === 1) return "green";
  if (sawGray) return "gray";
  return sawAny ? "na" : "na";
}

function expandPerformanceMetrics(
  checks: RisCheck[],
  products: string[],
  results: RisCheckResult[],
  monthPeriod: string,
): PerformanceMetric[] {
  const byKey = new Map<string, RisCheckResult>();
  for (const r of results) {
    byKey.set(resultKey(r.checkId, r.locationId ?? null, r.period), r);
  }
  const metrics: PerformanceMetric[] = [];
  for (const check of checks) {
    if (check.layer !== "performance") continue;
    if (check.product !== "universal" && !products.includes(check.product)) {
      continue;
    }
    // V1 Performance checks are product-level (no location fan-out).
    const r = byKey.get(resultKey(check.id, null, monthPeriod));
    const effectiveSeverity =
      (r?.severityOverride as string | null) ?? check.defaultSeverity;
    metrics.push({
      checkId: check.id,
      key: check.key,
      label: check.label,
      description: check.description ?? null,
      product: check.product,
      category: check.category,
      metricType: check.metricType ?? null,
      defaultSeverity: check.defaultSeverity,
      effectiveSeverity,
      defaultOwnerFunction: check.defaultOwnerFunction ?? null,
      period: monthPeriod,
      resultId: r?.id ?? null,
      status: (r?.status as RisPerformanceStatus) ?? null,
      observedValue: r?.observedValue ?? null,
      currentValue: r?.currentValue ?? null,
      previousValue: r?.previousValue ?? null,
      targetValue: r?.targetValue ?? null,
      changePct: r?.changePct ?? null,
      notes: r?.notes ?? null,
      source: r?.source ?? null,
      autoError: r?.autoError ?? null,
      checkedAt: r?.checkedAt ?? null,
      confirmedAt: r?.confirmedAt ?? null,
    });
  }
  return metrics;
}

/** Group metrics into Product Health Cards. Universal first, then each
 *  active product in catalog order. Products with no metrics are skipped. */
function buildHealthCards(metrics: PerformanceMetric[]): ProductHealthCard[] {
  const byProduct = new Map<string, PerformanceMetric[]>();
  for (const m of metrics) {
    const arr = byProduct.get(m.product) ?? [];
    arr.push(m);
    byProduct.set(m.product, arr);
  }
  const order = Array.from(byProduct.keys()).sort((a, b) => {
    if (a === "universal") return -1;
    if (b === "universal") return 1;
    return a.localeCompare(b);
  });
  const cards: ProductHealthCard[] = [];
  for (const product of order) {
    const ms = byProduct.get(product)!;
    const counts: PerformanceStatusCounts = {
      green: 0,
      yellow: 0,
      red: 0,
      gray: 0,
      na: 0,
    };
    let topSeverity: string | null = null;
    for (const m of ms) {
      if (m.status === "green") counts.green++;
      else if (m.status === "yellow") counts.yellow++;
      else if (m.status === "red") counts.red++;
      else if (m.status === "na") counts.na++;
      else counts.gray++; // null or gray → unknown bucket
      if (m.status === "red") {
        if (
          topSeverity == null ||
          rankSeverity(m.effectiveSeverity) > rankSeverity(topSeverity)
        ) {
          topSeverity = m.effectiveSeverity;
        }
      }
    }
    cards.push({
      product,
      status: worstPerformanceStatus(ms.map((m) => m.status)),
      counts,
      topSeverity,
      metrics: ms,
    });
  }
  return cards;
}

function sumPerfCounts(cards: ProductHealthCard[]): PerformanceStatusCounts {
  const totals: PerformanceStatusCounts = {
    green: 0,
    yellow: 0,
    red: 0,
    gray: 0,
    na: 0,
  };
  for (const c of cards) {
    totals.green += c.counts.green;
    totals.yellow += c.counts.yellow;
    totals.red += c.counts.red;
    totals.gray += c.counts.gray;
    totals.na += c.counts.na;
  }
  return totals;
}

export async function buildClientPerformance(
  clientId: string,
  monthPeriod: string,
): Promise<ClientPerformance | null> {
  const client = await getClient(clientId);
  if (!client) return null;
  const [checks, results] = await Promise.all([
    listRisChecks({ activeOnly: true, layer: "performance" }),
    getRisResultsForClient(clientId, [monthPeriod]),
  ]);
  const products = applicableProducts(client);
  const metrics = expandPerformanceMetrics(checks, products, results, monthPeriod);
  return {
    client: { id: client.id, firmName: client.firmName },
    products,
    period: monthPeriod,
    cards: buildHealthCards(metrics),
  };
}

export async function buildPortfolioPerformance(
  monthPeriod: string,
): Promise<PortfolioPerformance> {
  const [clients, checks, results] = await Promise.all([
    getActiveClients(),
    listRisChecks({ activeOnly: true, layer: "performance" }),
    getRisResultsForPeriods([monthPeriod]),
  ]);

  const resultsByClient = new Map<string, RisCheckResult[]>();
  for (const r of results) {
    const arr = resultsByClient.get(r.clientId) ?? [];
    arr.push(r);
    resultsByClient.set(r.clientId, arr);
  }

  const summaries: ClientPerformanceSummary[] = [];
  const allCards: ProductHealthCard[] = [];
  for (const client of clients) {
    const products = applicableProducts(client);
    const metrics = expandPerformanceMetrics(
      checks,
      products,
      resultsByClient.get(client.id) ?? [],
      monthPeriod,
    );
    const cards = buildHealthCards(metrics);
    allCards.push(...cards);
    let topSeverity: string | null = null;
    for (const c of cards) {
      if (
        c.topSeverity &&
        (topSeverity == null ||
          rankSeverity(c.topSeverity) > rankSeverity(topSeverity))
      ) {
        topSeverity = c.topSeverity;
      }
    }
    summaries.push({
      clientId: client.id,
      firmName: client.firmName,
      products,
      status: worstPerformanceStatus(cards.map((c) => c.status)),
      counts: sumPerfCounts(cards),
      topSeverity,
    });
  }

  return {
    period: monthPeriod,
    clients: summaries,
    totals: sumPerfCounts(allCards),
  };
}
