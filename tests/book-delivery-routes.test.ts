/* test-registration
{
  "name": "Book delivery HTTP privacy, cache, and stream-audit contract (Task #5104)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast and deterministic loopback HTTP coverage for the paid-book delivery boundary: buyer-specific asset metadata and generic denials are private/no-store, successful streams complete, unavailable and oversized streams terminate with safe audit outcomes, and client-aborted downloads cannot remain accepted-only. This is the lowest layer that can prove real Express headers and response finish/close semantics.",
  "tier": "small",
  "tierReason": "One in-process Express server, five loopback requests, injected in-memory streams, no DB queries or external network, and no child process. The imported production route graph initializes managed test pools, which are explicitly closed; measured end-to-end runtime is about 5-6 seconds."
}
test-registration */

import express from "express";
import http, { type Server } from "node:http";
import { PassThrough, Readable } from "node:stream";

import {
  registerBookDeliveryRoutes,
  type BookDeliveryRouteDeps,
} from "../server/routes/bookDelivery";
import { closeDbPools } from "../server/db";

type DownloadOutcome = "completed" | "unavailable" | "failed";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const outcomes: DownloadOutcome[] = [];
let maxBytes = 1024;
let openStream: BookDeliveryRouteDeps["createPrivateObjectReadStream"] =
  async () => Readable.from([Buffer.from("final-book")]);

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok  ${message}`);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  registerBookDeliveryRoutes(app, {
    listBookDeliveryAssetsForSession: async () =>
      ({
        entitlement: { id: "entitlement-1" },
        assets: [
          {
            id: "asset-1",
            filename: "The Final Book.pdf",
            contentType: "application/pdf",
            entitlementCode: "digital_book",
          },
        ],
      }) as any,
    authorizeBookDeliveryDownload: async ({ assetId }) =>
      assetId === "asset-1"
        ? ({
            entitlement: { id: "entitlement-1" },
            asset: {
              id: "asset-1",
              objectKey: "private-book-assets/final.pdf",
              filename: "The Final Book.pdf",
              contentType: "application/pdf",
              maxBytes,
            },
          } as any)
        : null,
    recordBookDeliveryDownloadOutcome: async ({ outcome }) => {
      outcomes.push(outcome);
    },
    createPrivateObjectReadStream: (objectKey) => openStream(objectKey),
  });
  return app;
}

async function listen(app: express.Express): Promise<{
  server: Server;
  baseUrl: string;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function request(baseUrl: string, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}${path}`,
      { headers: { Cookie: "nb_book_access=test-session" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

async function abortAfterFirstChunk(baseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/book/delivery/download/asset-1`,
      { headers: { Cookie: "nb_book_access=test-session" } },
      (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
        res.on("error", () => {
          // Destroying the client response intentionally may emit ECONNRESET.
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
  });
}

async function waitForOutcome(outcome: DownloadOutcome): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!outcomes.includes(outcome) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  check(outcomes.includes(outcome), `download audit records ${outcome}`);
}

async function main(): Promise<void> {
  const { server, baseUrl } = await listen(buildApp());
  try {
    const assets = await request(baseUrl, "/api/book/delivery/assets");
    check(assets.status === 200, "authorized asset metadata returns 200");
    check(
      assets.headers["cache-control"] === "private, no-store",
      "authorized asset metadata is private and no-store",
    );
    check(
      !assets.body.toString("utf8").includes("private-book-assets"),
      "asset metadata never exposes the private object key",
    );

    const denied = await request(
      baseUrl,
      "/api/book/delivery/download/not%20a%20safe%20id",
    );
    check(denied.status === 404, "malformed asset identifiers get a generic denial");
    check(
      denied.headers["cache-control"] === "private, no-store",
      "generic access denials are private and no-store",
    );

    outcomes.length = 0;
    openStream = async () => {
      throw new Error("provider detail that must not reach the response");
    };
    const unavailable = await request(
      baseUrl,
      "/api/book/delivery/download/asset-1",
    );
    check(unavailable.status === 503, "storage-open failure returns a safe 503");
    check(
      !unavailable.body.toString("utf8").includes("provider detail"),
      "storage-open failure hides provider detail",
    );
    await waitForOutcome("unavailable");

    outcomes.length = 0;
    maxBytes = 3;
    openStream = async () => Readable.from([Buffer.from("too-large")]);
    const oversized = await request(
      baseUrl,
      "/api/book/delivery/download/asset-1",
    );
    check(oversized.status === 503, "configured size-bound failure returns 503");
    await waitForOutcome("failed");

    outcomes.length = 0;
    maxBytes = 1024;
    openStream = async () => Readable.from([Buffer.from("final-book")]);
    const completed = await request(
      baseUrl,
      "/api/book/delivery/download/asset-1",
    );
    check(
      completed.status === 200 && completed.body.toString("utf8") === "final-book",
      "successful authorized download streams exact bytes",
    );
    check(
      completed.headers["cache-control"] === "private, no-store",
      "download bytes are private and no-store",
    );
    await waitForOutcome("completed");

    outcomes.length = 0;
    const slowStream = new PassThrough();
    openStream = async () => slowStream;
    setTimeout(() => slowStream.write(Buffer.from("partial")), 5);
    await abortAfterFirstChunk(baseUrl);
    await waitForOutcome("failed");
    check(slowStream.destroyed, "client abort destroys the upstream private stream");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeDbPools();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});