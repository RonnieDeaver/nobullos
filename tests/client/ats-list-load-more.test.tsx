/* test-registration
{
  "name": "ATS admin lists load on demand — useAtsInfiniteList + first-page prefetch (Task #3979)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3979: ATS admin lists switched from an up-front all-pages walk to on-demand paging. Mounts a component on the real useAtsInfiniteList hook in jsdom with a stubbed fetch and asserts: only the first page is fetched on mount, fetchNextPage requests exactly the returned continuation cursor and appends (no dups/skips), hasNextPage goes false on the terminal page, the legacy bare-array shape terminates, and the route prefetcher primes ONLY page one in the infinite-query cache shape under the page's query key. DB-free, network-free, fast.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3979 — load ATS admin lists on demand.
 *
 * The ATS list endpoints stay cursor-paginated ({ items, nextCursor, limit }
 * envelopes, Task #3962); the client no longer walks every continuation page
 * up-front. This covers the load-more path of the shared hook the AtsAdmin
 * page consumes (jobs / submissions / interviews all route through it) plus
 * the first-page-only route prefetcher:
 *   1. Mount → exactly ONE request (no cursor param); items = page 1;
 *      hasNextPage true.
 *   2. fetchNextPage → second request carries cursor=<page1.nextCursor>;
 *      items accumulate in order, no duplicates; terminal page flips
 *      hasNextPage false and further load-more is a no-op.
 *   3. Legacy bare-array body (stale server) → single terminal page.
 *   4. ATS_PAGINATED_PREFETCHERS["/api/ats/jobs"] fetches only page 1 and
 *      caches { pages: [page1], pageParams: [null] } under ["/api/ats/jobs"]
 *      — the exact shape the page's useInfiniteQuery consumes.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fetch stub: 2-page jobs walk + a legacy bare-array endpoint.
// ---------------------------------------------------------------------------

const PAGE1 = { jobs: [{ id: "j1" }, { id: "j2" }], nextCursor: "CUR1", limit: 2 };
const PAGE2 = { jobs: [{ id: "j3" }], nextCursor: null, limit: 2 };
const requests: string[] = [];

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      // Task #4005: the candidates list joined the same envelope under the
      // "candidates" items key.
      path: "/api/ats/jobs/job-1/candidates",
      respond: ({ url }: { url: string }) => {
        requests.push(url);
        const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
        if (cursor === null)
          return { status: 200, json: { candidates: [{ id: "c1" }, { id: "c2" }], nextCursor: "CCUR1", limit: 2 } };
        if (cursor === "CCUR1")
          return { status: 200, json: { candidates: [{ id: "c3" }], nextCursor: null, limit: 2 } };
        return { status: 400, json: { error: "invalid cursor" } };
      },
    },
    {
      path: "/api/ats/jobs",
      respond: ({ url }: { url: string }) => {
        requests.push(url);
        const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
        if (cursor === null) return { status: 200, json: PAGE1 };
        if (cursor === "CUR1") return { status: 200, json: PAGE2 };
        return { status: 400, json: { error: "invalid cursor" } };
      },
    },
    {
      path: "/api/ats/legacy",
      respond: ({ url }: { url: string }) => {
        requests.push(url);
        return { status: 200, json: [{ id: "old1" }, { id: "old2" }] };
      },
    },
  ],
  defaultJson: {},
}) as any;
(globalThis as any).fetch = fetchStub;
(dom.window as any).fetch = fetchStub;

// ---------------------------------------------------------------------------
// Imports — AFTER jsdom globals + fetch shim.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useAtsInfiniteList, ATS_PAGINATED_PREFETCHERS } = await import(
  "../../client/src/lib/atsListPagination"
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let latest: any = null;
function Probe(props: { basePath: string; itemsKey: any; queryKey: any[] }): any {
  latest = useAtsInfiniteList<{ id: string }>({
    queryKey: props.queryKey,
    basePath: props.basePath,
    itemsKey: props.itemsKey,
    enabled: true,
  });
  return null;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function main(): Promise<void> {
  console.log("ATS on-demand list paging (Task #3979)");
  const container = document.getElementById("root")!;
  let root: Root = null as any;

  // ── 1+2: paged walk with an explicit load-more ────────────────────────────
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(Probe, {
          basePath: "/api/ats/jobs",
          itemsKey: "jobs",
          queryKey: ["/api/ats/jobs"],
        }),
      ),
    );
  });
  await flush();

  assert(requests.length === 1, `mount fetched exactly one page (got ${requests.length}: ${requests.join(", ")})`);
  assert(!requests[0].includes("cursor="), "first request has no cursor param");
  assert(
    JSON.stringify(latest.items.map((i: any) => i.id)) === JSON.stringify(["j1", "j2"]),
    `page-1 items rendered (got ${JSON.stringify(latest.items)})`,
  );
  assert(latest.hasNextPage === true, "hasNextPage true after page 1");

  await act(async () => {
    latest.fetchNextPage();
  });
  await flush();

  assert(requests.length === 2, `load-more fetched exactly one more page (got ${requests.length})`);
  assert(
    requests[1].includes("cursor=CUR1"),
    `load-more request carries the continuation cursor (got ${requests[1]})`,
  );
  assert(
    JSON.stringify(latest.items.map((i: any) => i.id)) === JSON.stringify(["j1", "j2", "j3"]),
    `items accumulated in order without duplicates (got ${JSON.stringify(latest.items)})`,
  );
  assert(latest.hasNextPage === false, "hasNextPage false after terminal page");

  // Further load-more is a no-op (no phantom request past the terminal page).
  await act(async () => {
    latest.fetchNextPage();
  });
  await flush();
  assert(requests.length === 2, "fetchNextPage after terminal page issues no request");

  // ── 2b: candidates items key pages the same way (Task #4005) ─────────────
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(Probe, {
          basePath: "/api/ats/jobs/job-1/candidates",
          itemsKey: "candidates",
          queryKey: ["/api/ats/jobs", "job-1", "candidates"],
        }),
      ),
    );
  });
  await flush();
  assert(
    JSON.stringify(latest.items.map((i: any) => i.id)) === JSON.stringify(["c1", "c2"]),
    `candidates page-1 items rendered (got ${JSON.stringify(latest.items)})`,
  );
  assert(latest.hasNextPage === true, "candidates hasNextPage true after page 1");
  await act(async () => {
    latest.fetchNextPage();
  });
  await flush();
  assert(
    JSON.stringify(latest.items.map((i: any) => i.id)) === JSON.stringify(["c1", "c2", "c3"]),
    `candidates accumulated in order (got ${JSON.stringify(latest.items)})`,
  );
  assert(latest.hasNextPage === false, "candidates hasNextPage false after terminal page");

  // ── 3: legacy bare-array shape terminates as a single page ───────────────
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(Probe, {
          basePath: "/api/ats/legacy",
          itemsKey: "jobs",
          queryKey: ["/api/ats/legacy"],
        }),
      ),
    );
  });
  await flush();
  assert(
    JSON.stringify(latest.items.map((i: any) => i.id)) === JSON.stringify(["old1", "old2"]),
    "legacy bare-array body renders as items",
  );
  assert(latest.hasNextPage === false, "legacy bare-array shape is terminal (no next page)");

  await act(async () => {
    root.unmount();
  });

  // ── 4: route prefetcher primes only the FIRST page, in infinite shape ────
  const prefetchClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const before = requests.length;
  const prefetch = ATS_PAGINATED_PREFETCHERS["/api/ats/jobs"];
  assert(typeof prefetch === "function", "jobs prefetcher registered");
  await prefetch!(prefetchClient);
  assert(requests.length === before + 1, "prefetch fetched exactly one page");
  assert(!requests[before].includes("cursor="), "prefetch request has no cursor param");
  const cached: any = prefetchClient.getQueryData(["/api/ats/jobs"]);
  assert(cached && Array.isArray(cached.pages), "cache entry is infinite-query shaped ({ pages })");
  assert(cached.pages.length === 1, "only one page cached");
  assert(
    JSON.stringify(cached.pages[0].items.map((i: any) => i.id)) === JSON.stringify(["j1", "j2"]),
    "cached first page carries page-1 items",
  );
  assert(cached.pages[0].nextCursor === "CUR1", "cached first page preserves the continuation cursor");
  assert(
    Array.isArray(cached.pageParams) && cached.pageParams.length === 1 && cached.pageParams[0] === null,
    "pageParams is the single initial (null) param",
  );

  prefetchClient.clear();
  queryClient.clear();
  console.log("PASS ats-list-load-more");
}

await main();
