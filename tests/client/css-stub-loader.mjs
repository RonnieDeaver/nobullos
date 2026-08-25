// ESM resolve hook: stub every `.css` import with an empty module so plain
// react-dom/server component tests can import client components that pull in
// stylesheets (Vite handles those in the real build; node cannot).
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return {
      url: "data:text/javascript,export default {};",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
