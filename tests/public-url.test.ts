/* test-registration
{
  "name": "Public base-URL helper (Task #864)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// SPDX-License-Identifier: MIT
//
// Task #864: unit coverage for the shared public-base-URL helper that the
// Twilio webhook routes and outbound voice/SMS service all share. Each
// branch of the resolution chain is exercised independently so a future
// edit to the helper cannot silently regress one fallback.
//
// Usage: tsx tests/public-url.test.ts

import { getPublicBaseUrl } from "../server/services/publicUrl";

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

interface SnapshotKeys {
  REPLIT_DOMAINS?: string;
  REPLIT_DEV_DOMAIN?: string;
  REPL_SLUG?: string;
  REPL_OWNER?: string;
  NODE_ENV?: string;
}

function snapshot(): SnapshotKeys {
  return {
    REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
    REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
    REPL_SLUG: process.env.REPL_SLUG,
    REPL_OWNER: process.env.REPL_OWNER,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function restore(snap: SnapshotKeys): void {
  for (const key of Object.keys(snap) as (keyof SnapshotKeys)[]) {
    const v = snap[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

function clearAll(): void {
  delete process.env.REPLIT_DOMAINS;
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.REPL_SLUG;
  delete process.env.REPL_OWNER;
  delete process.env.NODE_ENV;
}

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const snap = snapshot();
  try {
    clearAll();
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    fn();
  } finally {
    restore(snap);
  }
}

function testReplitDomainsWins(): void {
  console.log("\nREPLIT_DOMAINS takes precedence over every other source");
  withEnv(
    {
      REPLIT_DOMAINS: "prod.example.com,backup.example.com",
      REPLIT_DEV_DOMAIN: "dev.replit.dev",
      REPL_SLUG: "slug",
      REPL_OWNER: "owner",
      NODE_ENV: "production",
    },
    () => {
      const url = getPublicBaseUrl();
      check("returns first REPLIT_DOMAINS entry", url === "https://prod.example.com", `got ${url}`);
    },
  );
}

function testReplitDevDomain(): void {
  console.log("\nFalls back to REPLIT_DEV_DOMAIN when REPLIT_DOMAINS is unset");
  withEnv(
    {
      REPLIT_DEV_DOMAIN: "dev.replit.dev",
      REPL_SLUG: "slug",
      REPL_OWNER: "owner",
      NODE_ENV: "development",
    },
    () => {
      const url = getPublicBaseUrl();
      check("uses dev domain", url === "https://dev.replit.dev", `got ${url}`);
    },
  );
}

function testReplSlugLegacy(): void {
  console.log("\nFalls back to REPL_SLUG / REPL_OWNER when nothing else is set");
  withEnv(
    {
      REPL_SLUG: "myrepl",
      REPL_OWNER: "alice",
      NODE_ENV: "development",
    },
    () => {
      const url = getPublicBaseUrl();
      check("uses legacy *.repl.co", url === "https://myrepl.alice.repl.co", `got ${url}`);
    },
  );
}

function testNoHostnameThrows(): void {
  console.log("\nThrows in dev/prod when no public hostname is available");
  withEnv({ NODE_ENV: "production" }, () => {
    let threw = false;
    try {
      getPublicBaseUrl();
    } catch {
      threw = true;
    }
    check("strict mode throws", threw);
  });
}

function testTestEnvAllowsLocalhost(): void {
  console.log("\nNODE_ENV=test always returns the localhost fallback");
  withEnv({ NODE_ENV: "test" }, () => {
    const url = getPublicBaseUrl();
    check("returns localhost in test", url === "https://localhost:5000", `got ${url}`);
  });
}

function testAllowLocalhostFallbackOption(): void {
  console.log("\nallowLocalhostFallback returns localhost instead of throwing");
  withEnv({ NODE_ENV: "production" }, () => {
    const url = getPublicBaseUrl({ allowLocalhostFallback: true });
    check("returns localhost when opted in", url === "https://localhost:5000", `got ${url}`);
  });
}

function testEmptyReplitDomainsFallsThrough(): void {
  console.log("\nEmpty / whitespace REPLIT_DOMAINS is ignored, not treated as a hostname");
  withEnv(
    {
      REPLIT_DOMAINS: " , ,",
      REPLIT_DEV_DOMAIN: "dev.replit.dev",
      NODE_ENV: "development",
    },
    () => {
      const url = getPublicBaseUrl();
      check("falls through to dev domain", url === "https://dev.replit.dev", `got ${url}`);
    },
  );
}

async function main(): Promise<void> {
  console.log("publicUrl helper unit tests (Task #864)");
  testReplitDomainsWins();
  testReplitDevDomain();
  testReplSlugLegacy();
  testEmptyReplitDomainsFallsThrough();
  testNoHostnameThrows();
  testTestEnvAllowsLocalhost();
  testAllowLocalhostFallbackOption();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
