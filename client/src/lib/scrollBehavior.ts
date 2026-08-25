/**
 * Task #4676 — shared reduced-motion scroll helper.
 *
 * CSS `scroll-behavior` rules can't override an explicit JS `behavior` option,
 * so every programmatic smooth scroll must check prefers-reduced-motion itself
 * (same guard SectionNav grew in Task #4659). Use `motionSafeScrollBehavior()`
 * instead of hard-coding `behavior: "smooth"` so users who ask the OS for less
 * motion get an instant jump.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** `"auto"` under prefers-reduced-motion, `"smooth"` otherwise. */
export function motionSafeScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
