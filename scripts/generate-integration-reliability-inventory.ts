/**
 * Task #4178 — governance inventory #2: integration reliability.
 *
 * Emits audits/governance/integration-reliability.json: one row per external
 * vendor. The vendor rows combine:
 *   - a CURATED registry (below) of adapter files, credential env-names /
 *     system_settings keys, webhook receivers, breakers and criticality
 *     tiers — every listed adapter file is VERIFIED to exist and every
 *     listed env-name is VERIFIED to appear in server source, so renames or
 *     retirements make `--check` fail loudly instead of rotting silently;
 *   - `unknown`/`none` for every field that cannot be proven — the visible
 *     grandfathered-debt record the hardening epic requires. New or changed
 *     vendors must fill their row completely (guard #4, gate-policy
 *     integrity, enforces this once activated).
 *
 * Criticality tiers (defined here per the epic approval's open-decision
 * record; rationale in audits/governance/decision-ledger.md):
 *   T1 = revenue/client-communication critical (outage = immediate business
 *        impact), T2 = important operational (degrades workflows), T3 =
 *        peripheral/enhancement.
 *
 * Human judgments go in
 * audits/governance/overrides/integration-reliability.overrides.json.
 *
 * Regenerate: npx tsx scripts/generate-integration-reliability-inventory.ts
 * Freshness:  npx tsx scripts/generate-integration-reliability-inventory.ts --check
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOverrides,
  buildDocument,
  listSourceFiles,
  runGeneratorCli,
  type InventoryDocument,
} from "./governanceInventoryLib";

export const ARTIFACT_PATH = "audits/governance/integration-reliability.json";
export const OVERRIDES_PATH = "audits/governance/overrides/integration-reliability.overrides.json";
export const GENERATOR_VERSION = 1;
const REGEN = "npx tsx scripts/generate-integration-reliability-inventory.ts";

const UNKNOWN = "unknown";

interface VendorSeed {
  vendor: string;
  criticalityTier: "T1" | "T2" | "T3";
  direction: "outbound" | "inbound" | "bidirectional";
  adapterFiles: string[];
  credentialEnvNames: string[];
  credentialSettingsKeys: string[];
  webhookReceivers: string[];
  breakerOrSwitch: string;
  webhookOrPollModel: string;
  notes?: string;
}

/** Curated registry — adapter files and env-names are validated at generation
 * time. Judgment fields not listed here default to `unknown`. */
const VENDORS: VendorSeed[] = [
  {
    vendor: "front",
    criticalityTier: "T1",
    direction: "bidirectional",
    adapterFiles: ["server/services/frontIntegration.ts", "server/services/frontWebhookIngestion.ts"],
    credentialEnvNames: ["FRONT_WEBHOOK_SECRET"],
    credentialSettingsKeys: [],
    webhookReceivers: ["server/routes/integrations/frontConnection.ts"],
    breakerOrSwitch: "front auth-dead breaker at the token accessor (persisted; probe bypasses+resets)",
    webhookOrPollModel: "signed webhook receiver + polling sync/reconciliation sweeps (deployment-gated workers)",
    notes: "OAuth token pair in system_settings; refresh via withSingleFlightOAuthRefresh",
  },
  {
    vendor: "twilio",
    criticalityTier: "T1",
    direction: "bidirectional",
    adapterFiles: ["server/services/twilioService.ts", "server/services/twilioEvents.ts"],
    credentialEnvNames: [],
    credentialSettingsKeys: ["twilio"],
    webhookReceivers: ["server/routes/twilio.ts"],
    breakerOrSwitch: "route/worker feature gates in server/perfConfig.ts; webhook-collision alerts",
    webhookOrPollModel: "signature-verified voice/SMS webhooks + delivery-status callbacks",
  },
  {
    vendor: "zoom",
    criticalityTier: "T1",
    direction: "bidirectional",
    adapterFiles: ["server/services/zoomIntegration.ts", "server/services/zoomTokenKeepAliveScheduler.ts"],
    credentialEnvNames: ["ZOOM_S2S_ACCOUNT_ID", "ZOOM_S2S_CLIENT_ID", "ZOOM_S2S_CLIENT_SECRET", "ZOOM_S2S_WEBHOOK_SECRET_TOKEN"],
    credentialSettingsKeys: [],
    webhookReceivers: ["server/routes/integrations/zoom.ts"],
    breakerOrSwitch: "auth gate (reactive-401 + proactive-expiry both required); ZOOM_EVENT_INGEST_ENABLED / ZOOM_RECONCILIATION_ENABLED switches; token keep-alive scheduler",
    webhookOrPollModel: "CRC-verified webhooks (±5min ts) + reconciliation polling",
  },
  {
    vendor: "openai",
    criticalityTier: "T1",
    direction: "outbound",
    adapterFiles: ["server/aiModels.ts", "server/services/adsOs/openAiHelper.ts"],
    credentialEnvNames: ["OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_API_KEY", "AI_INTEGRATIONS_OPENAI_BASE_URL"],
    credentialSettingsKeys: [],
    webhookReceivers: [],
    breakerOrSwitch: "none proven (route-level AI limiter only)",
    webhookOrPollModel: "on-demand API calls",
    notes: "6+ direct importers — frozen debt baseline; vendor-confinement guard blocks net-new importers only",
  },
  {
    vendor: "semrush",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/semrushApi.ts", "server/services/semrushAuthBreaker.ts", "server/services/semrushCircuitBreaker.ts"],
    credentialEnvNames: ["SEMRUSH_V4_API_KEY"],
    credentialSettingsKeys: ["semrush"],
    webhookReceivers: [],
    breakerOrSwitch: "auth breaker + circuit breaker modules; token keep-alive scheduler; kill switches in perfConfig",
    webhookOrPollModel: "polling + inventory sync queue jobs",
  },
  {
    vendor: "google-ads",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/googleAdsIntegration.ts", "server/services/adsOs/googleAdsClient.ts"],
    credentialEnvNames: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
    credentialSettingsKeys: [],
    webhookReceivers: [],
    breakerOrSwitch: "auth-dead negative cache in Ads OS client",
    webhookOrPollModel: "scheduled sync (google_ads_sync queue job every 6h) + on-demand",
    notes: "single env-trio lane; rotate as a matching set",
  },
  {
    vendor: "google-calendar",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/googleCalendarIntegration.ts"],
    credentialEnvNames: ["GOOGLE_CALENDAR_REDIRECT_URI"],
    credentialSettingsKeys: [],
    webhookReceivers: [],
    breakerOrSwitch: "none proven; status per-user",
    webhookOrPollModel: "per-user OAuth, on-demand API calls",
  },
  {
    vendor: "google-sheets",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/googleDriveIntegration.ts"],
    credentialEnvNames: ["GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY"],
    credentialSettingsKeys: [],
    webhookReceivers: [],
    breakerOrSwitch: "none proven",
    webhookOrPollModel: "service-account, readonly Sheets lane (Drive lane retired 2026-08)",
  },
  {
    vendor: "clickup",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: [
      "server/services/clickUpClient.ts",
      "server/services/clickUpBreakerPersistence.ts",
      "server/services/adsOs/clickUpDirectory.ts",
      "server/services/adsOs/clickUpPracticeAreaContract.ts",
    ],
    credentialEnvNames: ["CLICKUP_API_TOKEN"],
    credentialSettingsKeys: ["clickup_company_auth_token"],
    webhookReceivers: [],
    breakerOrSwitch: "persisted breaker (clickUpBreakerPersistence); reconciliation kill switches",
    webhookOrPollModel: "on-demand + reconciliation sweep scheduler",
    notes: "per-user OAuth for user actions (403=user not connected, 503=admin secrets); Ads OS canonical Client List projection/replacement uses the runtime-rotatable company token",
  },
  {
    vendor: "slack",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/slackIntegration.ts", "server/services/slackAuthBreakerStuckAlerts.ts"],
    credentialEnvNames: ["SLACK_WEBHOOK_URL"],
    credentialSettingsKeys: ["slack_bot_token"],
    webhookReceivers: [],
    breakerOrSwitch: "Slack auth breaker in slackIntegration (stuck-breaker watcher: slackAuthBreakerStuckAlerts)",
    webhookOrPollModel: "outbound bot/webhook posting; profile sync on boot",
    notes: "never rely on Slack to report Slack failures (channel_not_found class)",
  },
  {
    vendor: "rev-ai",
    criticalityTier: "T2",
    direction: "bidirectional",
    adapterFiles: ["server/services/revAiClient.ts"],
    credentialEnvNames: ["REV_AI_API_TOKEN", "REV_AI_CALLBACK_SECRET"],
    credentialSettingsKeys: [],
    webhookReceivers: ["server/routes/revAiWebhook.ts"],
    breakerOrSwitch: "none proven; sweep backstop (atsTranscriptionSweep)",
    webhookOrPollModel: "job callbacks (Authorization-header auth, no HMAC) + sweep backstop",
  },
  {
    vendor: "livekit",
    criticalityTier: "T2",
    direction: "outbound",
    adapterFiles: ["server/services/livekitRecording.ts"],
    credentialEnvNames: ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_SERVER_URL"],
    credentialSettingsKeys: [],
    webhookReceivers: [],
    breakerOrSwitch: "none proven",
    webhookOrPollModel: "on-demand (browser calls + S3 egress recording)",
  },
  {
    vendor: "pandadoc",
    criticalityTier: "T3",
    direction: "outbound",
    adapterFiles: ["server/services/pandadocIntegration.ts"],
    credentialEnvNames: [],
    credentialSettingsKeys: ["pandadoc_api_key"],
    webhookReceivers: [],
    breakerOrSwitch: "probe terminal-auth handling + status cache",
    webhookOrPollModel: "on-demand sync",
  },
  {
    vendor: "bigquery",
    criticalityTier: "T3",
    direction: "outbound",
    adapterFiles: ["server/services/ris/bigQueryClient.ts"],
    credentialEnvNames: [],
    credentialSettingsKeys: ["bigquery"],
    webhookReceivers: [],
    breakerOrSwitch: "unconfigured/unreachable degrades to needs_review, never silent pass",
    webhookOrPollModel: "scheduled auto-pull (default OFF via system settings)",
  },
];

interface VendorEntry extends VendorSeed {
  owner: string;
  retryTaxonomy: string;
  idempotency: string;
  auditStatusAlerts: string;
  retention: string;
  testBoundary: string;
  review?: Record<string, unknown>;
}

export function generateFacts(repoRoot: string = process.cwd()): { vendors: VendorEntry[] } {
  // Validate curated facts against the tree so drift fails --check loudly.
  const problems: string[] = [];
  const serverSources = listSourceFiles(repoRoot, ["server"], /\.ts$/).map((f) =>
    readFileSync(join(repoRoot, f), "utf8"),
  );
  const allServerText = serverSources.join("\n");
  for (const v of VENDORS) {
    for (const f of [...v.adapterFiles, ...v.webhookReceivers]) {
      if (!existsSync(join(repoRoot, f))) problems.push(`${v.vendor}: listed file missing: ${f}`);
    }
    for (const env of v.credentialEnvNames) {
      if (!allServerText.includes(env)) problems.push(`${v.vendor}: env name "${env}" not found in server source`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`curated vendor registry drifted from the tree:\n  - ${problems.join("\n  - ")}`);
  }

  const entries = new Map<string, VendorEntry>();
  for (const v of VENDORS) {
    entries.set(v.vendor, {
      ...v,
      adapterFiles: [...v.adapterFiles].sort(),
      credentialEnvNames: [...v.credentialEnvNames].sort(),
      credentialSettingsKeys: [...v.credentialSettingsKeys].sort(),
      webhookReceivers: [...v.webhookReceivers].sort(),
      owner: UNKNOWN,
      retryTaxonomy: UNKNOWN,
      idempotency: UNKNOWN,
      auditStatusAlerts: UNKNOWN,
      retention: UNKNOWN,
      testBoundary: UNKNOWN,
    });
  }
  applyOverrides(entries, join(repoRoot, OVERRIDES_PATH));
  return { vendors: [...entries.values()].sort((a, b) => a.vendor.localeCompare(b.vendor)) };
}

export function generate(repoRoot: string = process.cwd()): InventoryDocument {
  return buildDocument({
    generator: "scripts/generate-integration-reliability-inventory.ts",
    generatorVersion: GENERATOR_VERSION,
    regenerateCommand: REGEN,
    facts: generateFacts(repoRoot),
    repoRoot,
  });
}

export function cliMain(argv: string[] = process.argv.slice(2)): number {
  return runGeneratorCli({
    argv,
    artifactPath: ARTIFACT_PATH,
    generate: () => generate(),
    label: "integration-reliability-inventory",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(cliMain());
}
