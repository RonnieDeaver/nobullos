// Resolve hook redirecting `@/components/QuicklinksBar` (or any import ending
// in components/QuicklinksBar) to a tiny inline stub. CommsContext.tsx imports
// `shouldRenderGlobalQuicklinksBar` from it at eval time; the real module drags
// in the whole app-nav graph (FeedbackButton, NotificationBell, …) which is
// irrelevant to the sidebar-categories DnD test. The stub must return TRUTHY
// from shouldRenderGlobalQuicklinksBar so CommsProvider mounts the real inner
// provider (a `() => null` heavyClientLoader stub would silently swap in the
// NULL_CONTEXT and no API calls would ever fire).

const STUB_URL = new URL("./comms-sidebar-categories-dnd-quicklinks-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === STUB_URL) {
    return nextResolve(specifier, context);
  }
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  if (cleaned.endsWith("components/QuicklinksBar")) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: [
        "export function shouldRenderGlobalQuicklinksBar() { return true; }",
        "export function GlobalAppNav() { return null; }",
        "const Stub = () => null;",
        "export default Stub;",
      ].join("\n"),
    };
  }
  return nextLoad(url, context);
}
