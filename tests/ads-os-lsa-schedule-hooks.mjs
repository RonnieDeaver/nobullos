// Resolve hook: redirect every import of criteriaService.ts to the re-exporting
// stub — EXCEPT imports made by the stub itself (its `export *` must reach the
// real module or it self-redirects forever). Task #3681.
const STUB = "ads-os-lsa-schedule-criteria-stub.mjs";

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const parent = context.parentURL ?? "";
  if (
    /\/server\/services\/adsOs\/criteriaService\.[tj]s$/.test(new URL(resolved.url).pathname) &&
    !parent.includes(STUB)
  ) {
    const stubUrl = new URL(`./${STUB}`, import.meta.url).href;
    return nextResolve(stubUrl, context);
  }
  return resolved;
}
