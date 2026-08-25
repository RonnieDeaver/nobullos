import { cn } from "@/lib/utils";

/**
 * BrandMark — the ONE way the internal OS renders NoBull brand artwork
 * (Task #4618; provenance: client/public/brand/README.md).
 *
 * Renders the exact approved artwork — the primary logo (wordmark) or the
 * bull icon mark — from the OS-owned `/brand/` static namespace. Never
 * redraw, recolor, restyle, or crop the artwork (brand guidelines
 * `docs/brand/no-bull-brand-guidelines-v2.pdf`); pick a supplied variant:
 *
 *   - `crimson` icon — identity chrome only (nav band, favicon,
 *     notifications). Per the Task #4600 accent rule, crimson never sits in
 *     working-UI content where it could read as an error state.
 *   - `black` / `white` — neutral placements on light / dark surfaces.
 *   - `earth` icon — soft content-area moments (empty states).
 *   - `full-color` logo — the wordmark on light surfaces (auth card, OG).
 *
 * `darkVariant` renders the CSS dual-image swap (`dark:hidden` /
 * `hidden dark:block`) so the mark follows the theme without JS — the same
 * pattern the sign-in lockup used. Size via `className` (e.g. `h-6 w-auto`);
 * `width` additionally stamps the img attribute so surfaces that must work
 * without stylesheets (the global error fallback) still size correctly.
 */
export const BRAND_ASSET_PATHS = {
  logo: {
    "full-color": "/brand/nobull-logo-full-color.svg",
    black: "/brand/nobull-logo-black.svg",
    white: "/brand/nobull-logo-white.svg",
  },
  icon: {
    crimson: "/brand/nobull-icon-crimson.svg",
    black: "/brand/nobull-icon-black.svg",
    white: "/brand/nobull-icon-white.svg",
    earth: "/brand/nobull-icon-earth.svg",
  },
} as const;

export type BrandLogoVariant = keyof typeof BRAND_ASSET_PATHS.logo;
export type BrandIconVariant = keyof typeof BRAND_ASSET_PATHS.icon;

interface CommonProps {
  /** Accessible name. Default "" — decorative, rendered aria-hidden. */
  alt?: string;
  /** Tailwind sizing/layout, e.g. "h-6 w-auto". */
  className?: string;
  /** Optional `width` attribute — sizing that survives without CSS. */
  width?: number;
  /** `data-testid`; the dark twin (if any) gets `<testId>-dark`. */
  testId?: string;
}

export type BrandMarkProps = CommonProps &
  (
    | { kind: "logo"; variant: BrandLogoVariant; darkVariant?: BrandLogoVariant }
    | { kind: "icon"; variant: BrandIconVariant; darkVariant?: BrandIconVariant }
  );

export function BrandMark({
  kind,
  variant,
  darkVariant,
  alt = "",
  className,
  width,
  testId,
}: BrandMarkProps) {
  // The union above guarantees `variant`/`darkVariant` are valid keys for
  // `kind`; widen for indexing only.
  const paths: Record<string, string> = BRAND_ASSET_PATHS[kind];
  const src = paths[variant];
  const darkSrc =
    darkVariant && darkVariant !== variant ? paths[darkVariant] : undefined;
  const decorative = alt === "";

  if (!darkSrc) {
    return (
      <img
        src={src}
        alt={alt}
        aria-hidden={decorative || undefined}
        className={className}
        width={width}
        data-testid={testId}
      />
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt}
        aria-hidden={decorative || undefined}
        className={cn(className, "dark:hidden")}
        width={width}
        data-testid={testId}
      />
      <img
        src={darkSrc}
        alt={alt}
        aria-hidden={decorative || undefined}
        className={cn(className, "hidden dark:block")}
        width={width}
        data-testid={testId ? `${testId}-dark` : undefined}
      />
    </>
  );
}
