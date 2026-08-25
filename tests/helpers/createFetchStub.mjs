// Shared `globalThis.fetch` stub builder for the heavy client DOM tests.
//
// Mounting a big real component graph in jsdom throws `X.map is not a function`
// / `X?.find is not a function` for every TanStack list query whose data the
// component iterates, because the usual catch-all `{}` default is an object, not
// an array (see `.agents/memory/mount-large-client-component-jsdom.md`). Each
// test re-implemented the same `jsonResponse(...)` shape plus a hand-rolled
// `if (url === ...) return ...` chain. This helper consolidates that into a
// declarative route table with a safe default, so adding the next list endpoint
// is one line instead of another bespoke branch.
//
// Usage:
//
//   const fetchStub = createFetchStub({
//     Headers: dom.window.Headers,
//     routes: [
//       // method-scoped exact/prefix/RegExp matches, in priority order:
//       { method: "PATCH", path: /\/api\/clients\/[^/]+$/, json: CLIENT },
//       { path: "/api/auth/user", json: CEO_USER },
//       { path: /\/api\/clients\/[^/]+\/locations$/, json: [] },
//       // full control (read the request body, record the call, branch status):
//       { path: /\/data-access\/[^/?]+$/, respond: ({ url, method, init }) => {
//           ...; return { status: 200, json: { ok: true } };
//       } },
//     ],
//     defaultJson: {},   // returned for anything unmatched (object is safe; use
//                        // a route returning [] for each list endpoint)
//   });
//   globalThis.fetch = fetchStub;
//
// A route matches when (a) its `method` (if given) equals the request method
// and (b) its matcher matches the URL. The matcher is the first present of:
//   - `test(url, method, init)` → boolean (full control)
//   - `path`: RegExp (`.test(url)`) or string (exact OR prefix match)
// Routes are evaluated top-to-bottom; the first match wins. A matched route
// responds with `respond(ctx)` (returns a full Response, or `{ status?, json }`)
// or with `json` (a value or a `(ctx) => value` factory) at `status` (200).

export function createJsonResponse(Headers) {
  return function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function urlOf(input) {
  return typeof input === "string" ? input : input?.url ?? String(input);
}

function methodOf(init) {
  return (init?.method || "GET").toUpperCase();
}

function routeMatches(route, url, method, init) {
  if (route.method && route.method.toUpperCase() !== method) return false;
  if (typeof route.test === "function") return !!route.test(url, method, init);
  const m = route.path;
  if (m == null) return true; // method-only (or unconditional) route
  if (m instanceof RegExp) return m.test(url);
  if (typeof m === "string") return url === m || url.startsWith(m);
  if (typeof m === "function") return !!m(url, method, init);
  return false;
}

function isResponseLike(value) {
  return value && typeof value.json === "function" && "ok" in value;
}

export function createFetchStub(options = {}) {
  const {
    Headers = globalThis.Headers,
    routes = [],
    defaultJson = {},
    defaultStatus = 200,
    onCall,
  } = options;

  if (!Headers) {
    throw new Error(
      "createFetchStub: a `Headers` constructor is required (pass dom.window.Headers).",
    );
  }
  const jsonResponse = createJsonResponse(Headers);

  return async function fetchStub(input, init) {
    const url = urlOf(input);
    const method = methodOf(init);
    const ctx = { url, method, init, jsonResponse };
    if (onCall) onCall(ctx);

    for (const route of routes) {
      if (!routeMatches(route, url, method, init)) continue;

      if (typeof route.respond === "function") {
        const result = await route.respond(ctx);
        if (isResponseLike(result)) return result;
        return jsonResponse(result?.status ?? route.status ?? defaultStatus, result?.json ?? result);
      }

      const body = typeof route.json === "function" ? await route.json(ctx) : route.json;
      return jsonResponse(route.status ?? defaultStatus, body);
    }

    const body = typeof defaultJson === "function" ? await defaultJson(ctx) : defaultJson;
    return jsonResponse(defaultStatus, body);
  };
}
