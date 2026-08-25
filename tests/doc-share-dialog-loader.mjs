// Resolve hook for tests/doc-share-dialog.test.ts: redirects the bare
// `@radix-ui/react-select` specifier to the interactive shim so the test can
// actually pick a teammate (the shared select shim renders the listbox as
// null). Dialog + CSS stubbing come from the shared heavyClientLoader
// registered alongside this hook in tests/doc-share-dialog-setup.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@radix-ui/react-select") {
    return {
      url: new URL("./doc-share-select-shim.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
