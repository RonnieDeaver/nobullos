/* test-registration
{
  "name": "Daily judgments run-all route — CEO gate and async acknowledgement",
  "regression": true,
  "smoke": true,
  "smokeReason": "This CEO-only control starts work across the active client portfolio. The live route test pins both the successful acknowledgement and the non-CEO 403 boundary without running production-like portfolio work.",
  "tier": "small",
  "tierReason": "The Express/auth path is database-backed, but this suite has two bounded requests, a stubbed runner, and no seeded portfolio data; its measured work is intentionally small."
}
test-registration */

import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import {
  __setDailyJudgmentRunnerForTest,
  registerAgentRoutes,
} from "../server/routes/agents";

const RUN = `daily-run-all-${randomBytes(4).toString("hex")}`;
const CEO_ID = `${RUN}-ceo`;
const NON_CEO_ID = `${RUN}-account-manager`;
let activeUserId: string | null = CEO_ID;
let runnerCalls = 0;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerAgentRoutes(app);
  return app;
}

async function call(baseUrl: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/admin/daily-judgments/run-all`, {
    method: "POST",
  });
  return { status: response.status, body: await response.json() };
}

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES
      (${CEO_ID}, 'ceo', 'Daily judgment CEO'),
      (${NON_CEO_ID}, 'account_manager', 'Daily judgment account manager')
  `);
  __setDailyJudgmentRunnerForTest(async () => {
    runnerCalls += 1;
  });

  const app = buildApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    activeUserId = CEO_ID;
    const ceoResponse = await call(baseUrl);
    assert.equal(ceoResponse.status, 200);
    assert.deepEqual(ceoResponse.body, { message: "Daily judgment generation started" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runnerCalls, 1, "the CEO acknowledgement must start the owned background runner once");

    activeUserId = NON_CEO_ID;
    const nonCeoResponse = await call(baseUrl);
    assert.equal(nonCeoResponse.status, 403);
    assert.equal(runnerCalls, 1, "a non-CEO request must not start portfolio work");

    console.log("daily-judgments-run-all-route: CEO acknowledgement and non-CEO gate passed");
  } finally {
    __setDailyJudgmentRunnerForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${NON_CEO_ID})`);
    await closeDbPools();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });