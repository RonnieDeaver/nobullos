// Task #2675 — ESM customization hook that redirects `@/hooks/use-toast` to a
// tiny recording stub so the dashboard-resilience DOM test can assert that a
// transient (recovered) data-load failure NEVER flashes the global "Request
// failed" toast.
//
// Both the shared `client/src/lib/queryClient.ts` (its QueryCache.onError) and
// `Dashboard.tsx` import from `@/hooks/use-toast`; redirecting the module by
// basename catches both the `@/hooks/use-toast` alias and any relative shape.
// Every `toast(...)` call is pushed onto `globalThis.__capturedToasts` so the
// test can assert the array stays empty across the transient→retry→success and
// terminal-failure flows.

const STUB_URL = "dashboard-toast-stub:module";

function basename(specifier) {
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1];
}

export async function resolve(specifier, context, nextResolve) {
  if (basename(specifier) === "use-toast") {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    const source = `
      function record(opts) {
        (globalThis.__capturedToasts ||= []).push(opts);
        return { id: "stub", dismiss() {}, update() {} };
      }
      export function toast(opts) { return record(opts); }
      export function useToast() {
        return { toast: record, dismiss() {}, toasts: [] };
      }
      export default { toast, useToast };
    `;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
