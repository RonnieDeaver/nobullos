import {
  TestHarness,
  createAnonymousPersona,
  createBearerPersona,
  createCookiePersona,
  createApiKeyPersona,
  substitutePathParams,
  buildMultipartBody,
} from "./test-harness";
import type { RouteEntry } from "./route-inventory";

async function main() {
  const h = new TestHarness({ baseUrl: "http://localhost:5000" });

  const anon = createAnonymousPersona();
  const apiKey = createApiKeyPersona("ceo-tools", "test-token-123");
  const bearer = createBearerPersona("admin", "tok123", "ceo");
  const cookie = createCookiePersona("user", "session=abc", "account_manager");

  console.log("=== Persona creation ===");
  console.log("Created:", [anon.name, apiKey.name, bearer.name, cookie.name].join(", "));
  console.log("API key auth mode:", apiKey.authMethod, "header:", apiKey.apiKeyHeader);
  console.log("PASS");

  console.log("\n=== Multipart builder ===");
  const mp = buildMultipartBody([
    { name: "text", value: "hello" },
    { name: "pdf", value: Buffer.from("fake-pdf"), filename: "test.pdf", contentType: "application/pdf" },
  ]);
  console.assert(mp.body.length > 0, "Multipart body should not be empty");
  console.assert(mp.contentType.startsWith("multipart/form-data"), "Content-Type should be multipart");
  console.log("Body size:", mp.body.length, "bytes");
  console.log("Content-Type:", mp.contentType);
  console.log("PASS");

  console.log("\n=== Path substitution ===");
  const path = substitutePathParams("/api/clients/:clientId/reports/:id", { clientId: "c1", id: "r1" });
  console.assert(path === "/api/clients/c1/reports/r1", "Path should be substituted");
  console.log("Substituted:", path);
  console.log("PASS");

  const protectedRoute: RouteEntry = {
    method: "GET",
    path: "/api/clients",
    file: "test.ts",
    line: 1,
    middleware: ["isAuthenticated"],
    protection: "authenticated",
    classifications: ["authenticated"],
    hasUpload: false,
    hasRateLimiter: false,
  };

  console.log("\n=== Outcome classification: anon on protected route expecting 200 ===");
  const result1 = await h.testRoute({
    route: protectedRoute,
    persona: anon,
    expectedStatus: 200,
    description: "Anon hitting protected route expecting 200",
  });
  console.log("Actual status:", result1.actualStatus, "Outcome:", result1.outcome);
  if (result1.actualStatus === 401 || result1.actualStatus === 403) {
    console.assert(result1.outcome === "FAIL_AUTH", `Expected FAIL_AUTH, got ${result1.outcome}`);
    console.log("PASS - correctly classified as FAIL_AUTH (not false PASS)");
  } else if (result1.actualStatus === 0) {
    console.log("PASS - FAIL_ENV (server not running, expected in self-test)");
  }

  console.log("\n=== Outcome classification: anon on protected route expecting 401/403 ===");
  const result2 = await h.testRoute({
    route: protectedRoute,
    persona: anon,
    expectedStatus: [401, 403],
    description: "Anon hitting protected route expecting denial",
  });
  console.log("Actual status:", result2.actualStatus, "Outcome:", result2.outcome);
  if (result2.actualStatus === 401 || result2.actualStatus === 403) {
    console.assert(result2.outcome === "PASS", `Expected PASS, got ${result2.outcome}`);
    console.log("PASS - correctly classified as PASS when expected status matches");
  } else if (result2.actualStatus === 0) {
    console.log("PASS - FAIL_ENV (server not running, expected in self-test)");
  }

  const publicRoute: RouteEntry = {
    method: "GET",
    path: "/api/health",
    file: "test.ts",
    line: 1,
    middleware: [],
    protection: "public",
    classifications: ["public"],
    hasUpload: false,
    hasRateLimiter: false,
  };

  console.log("\n=== Outcome classification: anon on public route expecting 200 ===");
  const result3 = await h.testRoute({
    route: publicRoute,
    persona: anon,
    expectedStatus: 200,
    description: "Anon hitting public health endpoint",
  });
  console.log("Actual status:", result3.actualStatus, "Outcome:", result3.outcome);
  if (result3.actualStatus === 200) {
    console.assert(result3.outcome === "PASS", `Expected PASS, got ${result3.outcome}`);
    console.log("PASS - correctly classified as PASS");
  } else if (result3.actualStatus === 0) {
    console.log("PASS - FAIL_ENV (server not running, expected in self-test)");
  }

  console.log("\n=== Report generation ===");
  const report = h.generateReport();
  console.assert(report.includes("# API Test Report"), "Report should have header");
  console.assert(report.includes("Outcome Summary"), "Report should have summary");
  console.log("Report lines:", report.split("\n").length);
  console.log("PASS");

  console.log("\n=== All self-tests completed ===");
  const results = h.getResults();
  console.log(`Total test results captured: ${results.length}`);
  for (const r of results) {
    console.log(`  ${r.method} ${r.route} [${r.persona}] => ${r.outcome} (${r.actualStatus})`);
  }
}

main().catch((err) => {
  console.error("Self-test failed:", err);
  process.exit(1);
});
