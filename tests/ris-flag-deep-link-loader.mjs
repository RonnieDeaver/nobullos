// Node ESM resolve hook that redirects the three DB-touching dependencies of
// `server/services/ris/risFlagging.ts` to lightweight test stubs so the
// deep-link emission can be asserted without a database. Registered via
// `--import ./tests/ris-flag-deep-link-mock-setup.mjs`.

const USERINBOX_STUB = new URL(
  "./ris-flag-deep-link-userinbox-stub.mjs",
  import.meta.url,
).href;
const RECIPIENTS_STUB = new URL(
  "./ris-flag-deep-link-recipients-stub.mjs",
  import.meta.url,
).href;
const RISSERVICE_STUB = new URL(
  "./ris-flag-deep-link-risservice-stub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  // Don't redirect the stubs themselves.
  if (specifier.includes("ris-flag-deep-link-")) {
    return nextResolve(specifier, context);
  }
  if (specifier.endsWith("notifications/userInbox")) {
    return { url: USERINBOX_STUB, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith("notifications/recipients")) {
    return { url: RECIPIENTS_STUB, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith("ris/risService") || specifier.endsWith("./risService")) {
    return { url: RISSERVICE_STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
