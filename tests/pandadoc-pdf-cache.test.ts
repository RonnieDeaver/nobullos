/* test-registration
{
  "name": "PandaDoc PDF cache behavior (Task #1653)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1653 regression coverage for the PandaDoc PDF cache added to
 * `server/services/pandadocIntegration.ts` (getDocumentPdfCached,
 * invalidatePdfCache) and the unlink-invalidation hook in
 * `server/routes/agents.ts`.
 *
 * Locks the following behavior in place:
 *
 * 1. First call fetches from PandaDoc and writes to object storage;
 *    a second call with the same (documentId, lastSyncedAt) is served
 *    from cache and does not hit PandaDoc.
 * 2. Changing `lastSyncedAt` produces a cache miss and refetches.
 * 3. Unlinking a document invalidates every cached PDF entry for that
 *    documentId regardless of how many lastSyncedAt buckets exist.
 * 4. An object-storage write failure does not break the download path —
 *    the caller still receives the PDF buffer fetched from PandaDoc.
 *
 * `global.fetch` is monkey-patched so the suite never hits real
 * PandaDoc. `ObjectStorageService.prototype.streamUploadToPrivateKey` /
 * `.getPrivateObjectFileByKey` and `objectStorageClient.bucket` are
 * stubbed against an in-memory store so the suite never touches real
 * Replit Object Storage.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  ObjectNotFoundError,
  ObjectStorageService,
  objectStorageClient,
} from "../server/replit_integrations/object_storage";

const TEST_BUCKET = "test-bucket";
const TEST_BASE_PREFIX = "test-prefix";

const originalEnv = process.env.PRIVATE_OBJECT_DIR;
process.env.PRIVATE_OBJECT_DIR = `/${TEST_BUCKET}/${TEST_BASE_PREFIX}`;

const originalFetch: typeof fetch = global.fetch;
const originalUpload = ObjectStorageService.prototype.streamUploadToPrivateKey;
const originalRead = ObjectStorageService.prototype.getPrivateObjectFileByKey;
const originalBucket = objectStorageClient.bucket.bind(objectStorageClient);

const PANDADOC_KEY = "pandadoc_api_key";
let originalPandadocApiKey: string | undefined; // undefined = row missing

const store = new Map<string, Buffer>();
let failNextWrite = false;
let pandadocFetchCount = 0;
const pandadocCallLog: string[] = [];

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  // Task #1820: short-circuit Upstash REST calls so the
  // system_settings cache (fired on every storage write/read in this
  // suite) stays deterministic and never depends on a live Upstash
  // round-trip. `[{result:null}]` is treated as a miss for GET and a
  // no-op-success for SET/DEL by the @upstash/redis client.
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("api.pandadoc.com")) {
    pandadocCallLog.push(url);
    if (/\/documents\/[^/]+\/download/.test(url)) {
      pandadocFetchCount += 1;
      const body = Buffer.from(`%PDF-1.4 fake-pdf #${pandadocFetchCount}`);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    // Any other PandaDoc call (e.g. connection probe via /documents?count=1)
    // returns an empty result envelope; we never exercise it in this suite.
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

// In-memory upload — captures the streamed body into `store` keyed by
// the bare objectKey (the cache key, e.g. "pandadoc-pdf-cache/<id>/<ts>.pdf").
ObjectStorageService.prototype.streamUploadToPrivateKey = (async function (
  this: ObjectStorageService,
  objectKey: string,
  body: NodeJS.ReadableStream,
  _contentType: string,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of body as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (failNextWrite) {
    failNextWrite = false;
    throw new Error("simulated object storage write failure");
  }
  const buf = Buffer.concat(chunks);
  store.set(objectKey, buf);
  return { objectKey, size: buf.length };
}) as any;

ObjectStorageService.prototype.getPrivateObjectFileByKey = (async function (
  this: ObjectStorageService,
  objectKey: string,
) {
  const buf = store.get(objectKey);
  if (!buf) throw new ObjectNotFoundError();
  return {
    name: `${TEST_BASE_PREFIX}/${objectKey}`,
    download: async () => [buf],
  } as any;
}) as any;

// Fake `bucket()` used by invalidatePdfCache. We only need getFiles({prefix})
// to enumerate matching keys and return fake File handles whose `.delete()`
// removes them from the in-memory store.
(objectStorageClient as any).bucket = (name: string) => {
  if (name !== TEST_BUCKET) return originalBucket(name);
  return {
    getFiles: async ({ prefix }: { prefix: string }) => {
      const stripPrefix = `${TEST_BASE_PREFIX}/`;
      const innerPrefix = prefix.startsWith(stripPrefix)
        ? prefix.slice(stripPrefix.length)
        : prefix;
      const files = [] as any[];
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(innerPrefix)) {
          files.push({
            name: `${TEST_BASE_PREFIX}/${key}`,
            delete: async (_opts?: { ignoreNotFound?: boolean }) => {
              store.delete(key);
            },
          });
        }
      }
      return [files];
    },
  };
};

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

function resetCounters(): void {
  store.clear();
  pandadocFetchCount = 0;
  pandadocCallLog.length = 0;
  failNextWrite = false;
}

async function main(): Promise<void> {
  console.log("PandaDoc PDF cache regression (Task #1653)");

  // Snapshot + set the PandaDoc API key so getApiKey() doesn't throw.
  const existing = await storage.getSystemSetting(PANDADOC_KEY);
  originalPandadocApiKey = existing?.value;
  await storage.setSystemSetting(PANDADOC_KEY, "test-api-key", "test");

  const { getDocumentPdfCached, invalidatePdfCache } = await import(
    "../server/services/pandadocIntegration"
  );

  await step(
    "first call fetches + caches; second call with same lastSyncedAt is served from cache",
    async () => {
      resetCounters();
      const docId = "doc-cache-hit";
      const lastSyncedAt = new Date("2026-01-01T00:00:00Z");

      const first = await getDocumentPdfCached(docId, lastSyncedAt);
      assert.equal(first.cached, false, "first call should not be cached");
      assert.equal(first.contentType, "application/pdf");
      assert.ok(first.buffer.length > 0, "first call should return a buffer");
      assert.equal(
        pandadocFetchCount,
        1,
        "first call should hit PandaDoc exactly once",
      );
      assert.equal(store.size, 1, "first call should write one cache entry");

      const second = await getDocumentPdfCached(docId, lastSyncedAt);
      assert.equal(second.cached, true, "second call should be a cache hit");
      assert.equal(
        pandadocFetchCount,
        1,
        "second call must not hit PandaDoc again",
      );
      assert.deepEqual(
        second.buffer,
        first.buffer,
        "cached buffer should match the originally fetched buffer",
      );
    },
  );

  await step(
    "changing lastSyncedAt produces a cache miss and refetches",
    async () => {
      resetCounters();
      const docId = "doc-cache-miss-on-resync";
      const firstSync = new Date("2026-01-01T00:00:00Z");
      const secondSync = new Date("2026-02-01T00:00:00Z");

      const a = await getDocumentPdfCached(docId, firstSync);
      assert.equal(pandadocFetchCount, 1);
      assert.equal(a.cached, false);

      const b = await getDocumentPdfCached(docId, secondSync);
      assert.equal(
        pandadocFetchCount,
        2,
        "changing lastSyncedAt must refetch from PandaDoc",
      );
      assert.equal(b.cached, false, "different lastSyncedAt is a cache miss");
      assert.notDeepEqual(
        a.buffer,
        b.buffer,
        "refetched buffer should be a fresh body (different fetch counter)",
      );
      assert.equal(
        store.size,
        2,
        "both lastSyncedAt buckets should be cached side-by-side",
      );

      // The original (firstSync) entry must still be served from cache.
      const replayFirst = await getDocumentPdfCached(docId, firstSync);
      assert.equal(replayFirst.cached, true);
      assert.equal(
        pandadocFetchCount,
        2,
        "replaying the original lastSyncedAt must remain a cache hit",
      );
    },
  );

  await step(
    "invalidatePdfCache removes every cached PDF for the documentId",
    async () => {
      resetCounters();
      const docId = "doc-unlink-invalidates-all";
      const otherDocId = "doc-untouched";

      await getDocumentPdfCached(docId, new Date("2026-01-01T00:00:00Z"));
      await getDocumentPdfCached(docId, new Date("2026-02-01T00:00:00Z"));
      await getDocumentPdfCached(docId, new Date("2026-03-01T00:00:00Z"));
      await getDocumentPdfCached(otherDocId, new Date("2026-01-01T00:00:00Z"));
      assert.equal(store.size, 4, "should have cached four PDFs total");

      await invalidatePdfCache(docId);

      for (const key of store.keys()) {
        assert.ok(
          !key.includes(`/${docId}/`),
          `cache entry for unlinked docId should be gone, found ${key}`,
        );
      }
      assert.equal(
        store.size,
        1,
        "only the unrelated document's cache entry should remain",
      );

      // After invalidation, a follow-up call must refetch from PandaDoc.
      const fetchBefore = pandadocFetchCount;
      const afterInvalidate = await getDocumentPdfCached(
        docId,
        new Date("2026-01-01T00:00:00Z"),
      );
      assert.equal(afterInvalidate.cached, false);
      assert.equal(
        pandadocFetchCount,
        fetchBefore + 1,
        "post-invalidation call must hit PandaDoc again",
      );
    },
  );

  await step(
    "object-storage write failure does not break the download response",
    async () => {
      resetCounters();
      const docId = "doc-cache-write-failure";
      const lastSyncedAt = new Date("2026-01-01T00:00:00Z");

      failNextWrite = true;
      const result = await getDocumentPdfCached(docId, lastSyncedAt);
      assert.equal(
        result.cached,
        false,
        "fresh fetch should still report cached=false",
      );
      assert.ok(
        result.buffer.length > 0,
        "caller must still receive the PDF buffer even when cache write fails",
      );
      assert.equal(result.contentType, "application/pdf");
      assert.equal(
        pandadocFetchCount,
        1,
        "PandaDoc should have been called exactly once",
      );
      assert.equal(
        store.size,
        0,
        "failed write must not leave a partial cache entry behind",
      );

      // A follow-up call should refetch (nothing was cached) and this time
      // succeed at writing, so the entry lands in the store.
      const followUp = await getDocumentPdfCached(docId, lastSyncedAt);
      assert.equal(followUp.cached, false);
      assert.equal(
        pandadocFetchCount,
        2,
        "follow-up call should refetch because the prior write failed",
      );
      assert.equal(store.size, 1, "successful write should populate the cache");
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll PandaDoc PDF cache regression tests passed.");
  }
}

async function cleanup(): Promise<void> {
  global.fetch = originalFetch;
  ObjectStorageService.prototype.streamUploadToPrivateKey = originalUpload;
  ObjectStorageService.prototype.getPrivateObjectFileByKey = originalRead;
  (objectStorageClient as any).bucket = originalBucket;
  if (originalEnv === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = originalEnv;

  // Restore the PandaDoc API key snapshot so the dev DB isn't polluted.
  if (originalPandadocApiKey === undefined) {
    // Row didn't exist before — best-effort: blank it. setSystemSetting
    // doesn't expose a delete here, and other tests don't rely on the
    // setting being absent.
    await storage.setSystemSetting(PANDADOC_KEY, "", "test").catch(() => {});
  } else {
    await storage
      .setSystemSetting(PANDADOC_KEY, originalPandadocApiKey, "test")
      .catch(() => {});
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Unhandled error in PandaDoc PDF cache test:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exitCode = process.exitCode ?? 0;
  });
