/* test-registration
{
  "name": "OS canonical-host resolver (Task #3740)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3740: OS canonical-host resolver — Twilio callbacks + OAuth redirect URIs must stay pinned to reports.nobullmarketing.com no matter where in REPLIT_DOMAINS the marketing domains land once DNS connects. Pure env-permutation unit tests, DB-free, fast.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #3740: unit coverage for resolveOsCanonicalHostname() — the shared
// resolver that pins Twilio callbacks and the Zoom / Google Ads / Google
// Calendar / ClickUp / Front OAuth redirect builders to the OS's own host
// (reports.nobullmarketing.com) no matter where in the deployment's
// REPLIT_DOMAINS list the marketing apex/www domains land once DNS is
// connected. Every branch of the resolution chain is exercised across
// domain-order permutations so a future edit cannot silently let an OAuth
// redirect URI flip to nobullmarketing.com.
//
// Usage: tsx tests/canonical-host.test.ts

import {
  resolveOsCanonicalHostname,
  getPublicBaseUrl,
} from "../server/services/publicUrl";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ENV_KEYS = [
  "OS_CANONICAL_HOSTNAME",
  "MARKETING_SITE_HOSTS",
  "REPLIT_DOMAINS",
  "REPLIT_DEV_DOMAIN",
  "REPL_SLUG",
  "REPL_OWNER",
  "NODE_ENV",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function withEnv(env: Partial<Record<EnvKey, string>>, fn: () => void): void {
  const snap: Partial<Record<EnvKey, string | undefined>> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      const v = snap[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function testEnvOverrideWins(): void {
  console.log("\nOS_CANONICAL_HOSTNAME override beats everything");
  withEnv(
    {
      OS_CANONICAL_HOSTNAME: "pinned.example.com",
      REPLIT_DOMAINS:
        "reports.nobullmarketing.com,nobullmarketing.com,www.nobullmarketing.com",
    },
    () => {
      const host = resolveOsCanonicalHostname();
      check("returns the pinned host", host === "pinned.example.com", `got ${host}`);
    },
  );
}

function testReportsPreferredRegardlessOfOrder(): void {
  console.log("\n`reports.` entry wins regardless of list order");
  const permutations = [
    "reports.nobullmarketing.com,nobullmarketing.com,www.nobullmarketing.com",
    "nobullmarketing.com,reports.nobullmarketing.com,www.nobullmarketing.com",
    "nobullmarketing.com,www.nobullmarketing.com,reports.nobullmarketing.com",
    "www.nobullmarketing.com,nobullmarketing.com,reports.nobullmarketing.com",
  ];
  for (const domains of permutations) {
    withEnv({ REPLIT_DOMAINS: domains }, () => {
      const host = resolveOsCanonicalHostname();
      check(
        `[${domains}] -> reports.nobullmarketing.com`,
        host === "reports.nobullmarketing.com",
        `got ${host}`,
      );
    });
  }
}

function testCustomNonMarketingPreferred(): void {
  console.log("\nNo reports.* entry: first custom non-marketing domain wins");
  withEnv(
    { REPLIT_DOMAINS: "nobullmarketing.com,os.example.com" },
    () => {
      const host = resolveOsCanonicalHostname();
      check("marketing apex skipped", host === "os.example.com", `got ${host}`);
    },
  );
  withEnv(
    { REPLIT_DOMAINS: "myapp.replit.app,os.example.com" },
    () => {
      const host = resolveOsCanonicalHostname();
      check(
        "platform host skipped in favor of custom domain",
        host === "os.example.com",
        `got ${host}`,
      );
    },
  );
}

function testMarketingPlusPlatformOnly(): void {
  console.log("\nMarketing + platform hosts only: first non-marketing entry wins");
  withEnv(
    { REPLIT_DOMAINS: "nobullmarketing.com,myapp.replit.app" },
    () => {
      const host = resolveOsCanonicalHostname();
      check("falls back to platform host", host === "myapp.replit.app", `got ${host}`);
    },
  );
}

function testMarketingOnlyList(): void {
  console.log("\nMarketing-only list: first entry (never null once domains exist)");
  withEnv(
    { REPLIT_DOMAINS: "nobullmarketing.com,www.nobullmarketing.com" },
    () => {
      const host = resolveOsCanonicalHostname();
      check("returns first entry", host === "nobullmarketing.com", `got ${host}`);
    },
  );
}

function testEmptyDomains(): void {
  console.log("\nREPLIT_DOMAINS unset/empty: returns null");
  withEnv({}, () => {
    check("unset -> null", resolveOsCanonicalHostname() === null);
  });
  withEnv({ REPLIT_DOMAINS: " , ," }, () => {
    check("whitespace-only -> null", resolveOsCanonicalHostname() === null);
  });
}

function testMarketingHostsEnvOverride(): void {
  console.log("\nMARKETING_SITE_HOSTS override changes which domains are 'marketing'");
  withEnv(
    {
      MARKETING_SITE_HOSTS: "brand-x.example.com,www.brand-x.example.com",
      REPLIT_DOMAINS: "brand-x.example.com,os.example.com",
    },
    () => {
      const host = resolveOsCanonicalHostname();
      check("overridden marketing host skipped", host === "os.example.com", `got ${host}`);
    },
  );
}

function testGetPublicBaseUrlProductionScenario(): void {
  console.log("\ngetPublicBaseUrl(): the actual production scenario after DNS connect");
  withEnv(
    {
      REPLIT_DOMAINS:
        "nobullmarketing.com,www.nobullmarketing.com,reports.nobullmarketing.com",
      NODE_ENV: "production",
    },
    () => {
      const url = getPublicBaseUrl();
      check(
        "Twilio/OAuth base URL stays on reports.",
        url === "https://reports.nobullmarketing.com",
        `got ${url}`,
      );
    },
  );
  withEnv(
    {
      REPLIT_DOMAINS: "prod.example.com,backup.example.com",
      NODE_ENV: "production",
    },
    () => {
      const url = getPublicBaseUrl();
      check(
        "legacy two-domain behavior unchanged (first entry)",
        url === "https://prod.example.com",
        `got ${url}`,
      );
    },
  );
}

async function main(): Promise<void> {
  console.log("OS canonical-host resolver unit tests (Task #3740)");
  testEnvOverrideWins();
  testReportsPreferredRegardlessOfOrder();
  testCustomNonMarketingPreferred();
  testMarketingPlusPlatformOnly();
  testMarketingOnlyList();
  testEmptyDomains();
  testMarketingHostsEnvOverride();
  testGetPublicBaseUrlProductionScenario();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
