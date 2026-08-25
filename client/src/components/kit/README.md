# Status & state kit

Shared primitives that codify the app's best status/state patterns
(design audit `audits/internal-os-design-audit-2026-08.md` §8.3). Every
component is **token-only** (colors/type/z from `client/src/index.css`) and
**square-cornered** — the sole rounded shape is the pill (`--radius-pill`).

Import from `@/components/kit/<Component>`. The Card side-accent lives on the
existing `Card` (`@/components/ui/card`).

## KpiCard

Headline metric = label + value + unit + delta arrow + caption. `label` is
required and `caption` carries scale/window context, so no surface ships an
unlabeled "0.76" again.

```tsx
<KpiCard
  label="Health score"
  value="0.76"
  caption="Avg health score (0–1) · last 30 days"
  delta={{ value: 4, goodWhen: "up", label: "vs. June" }}
/>
```

Delta tone follows meaning, not direction (Ads OS MetricPill semantics):
`goodWhen: "up"` (leads), `"down"` (CPL/CPA), `"none"` (spend — always
neutral). Good movement = `--status-ok`, bad = `--status-critical`, flat/none
= muted. `kpiDeltaTone(delta)` is exported for reuse.

## StatusPill

The one status chip. Tones = `neutral` (default) · `ok` · `warn` ·
`critical` · `info`, mapped to `--status-*` tokens.

```tsx
<StatusPill tone="critical" dot>3 failing</StatusPill>
<StatusPill>Idle</StatusPill> {/* at rest → neutral, no tone prop needed */}
```

**Rule baked in: red only for actionable-now.** At-rest / historical /
informational chips stay `neutral`; `ok` marks confirmed-good moments, not
the permanent dress of healthy rows; `warn` = degraded-but-working. If a
pill would be `critical` forever, it's the wrong tone.

## EmptyState

Educational empty state (webhook-logs exemplar): say **what** this surface
is (`title`), **when** rows appear (`description`), **how to test**
(`hint`), and optionally what to do now (`action`).

```tsx
<EmptyState
  icon={<Webhook />}
  title="No webhook import attempts yet"
  description="Imports are triggered via POST /api/webhooks/report-import"
  action={<Button size="sm">View API docs</Button>}
/>
```

## DegradedState

"Integration needs attention" panel (Zoom-card exemplar): what broke +
how long (`title`, `since`), why (children = diagnostics), what the system
will do by itself (`retryAt` / `retryPaused`), and the explicit human path
out (`action`).

```tsx
<DegradedState
  title="Zoom needs to be reconnected"
  since={engagedSinceMs}
  retryAt={cooldownUntil}
  retryPaused={selfHealParked}
  action={<Button size="sm">Reconnect Zoom</Button>}
>
  <div>Auth blocked (status 401): token revoked…</div>
</DegradedState>
```

Tone `warn` (default) for reconnect-required/degraded-but-working;
`critical` only for actionable-now-or-else. `formatEngagedFor(ms)` ("2h 5m
ago") is exported for engaged-duration copy elsewhere.

## BrandMark

The one way the app renders NoBull brand artwork (primary logo wordmark or
the bull icon mark) — exact approved assets served from
`client/public/brand/` (provenance README there; guidelines
`docs/brand/no-bull-brand-guidelines-v2.pdf`). Never redraw, recolor, or
crop; pick a variant. `darkVariant` gives the CSS theme swap.

```tsx
<BrandMark kind="icon" variant="black" darkVariant="white" className="h-5 w-auto" />
<BrandMark kind="logo" variant="full-color" className="h-14 w-auto" alt="NoBull Marketing" />
<EmptyState icon={<BrandMark kind="icon" variant="earth" />} title="No clients yet." />
```

Variant rules (constitution + Task #4600 accent rule): **crimson** is
identity chrome (nav band, favicon, notifications) and never sits where it
could read as an error state; **black/white** are the neutral light/dark
placements; **earth** is the soft content-area moment (empty states).
`BRAND_ASSET_PATHS` is exported for the rare non-React consumer (Clerk
appearance config).

## DangerZone

Destructive actions never sit next to routine actions (P1-7). They live in
this separated, critical-outlined region; by default the actions are also
behind an explicit "Show destructive actions" reveal. The zone separates —
each action still brings its own confirmation dialog.

```tsx
<DangerZone description="These affect the live client record.">
  <Button variant="destructive" size="sm">Archive client</Button>
  <Button variant="destructive" size="sm">Initiate offboard</Button>
</DangerZone>
```

## Card `accent` (in `@/components/ui/card`)

The sanctioned side-accent stripe, replacing 12 copy-pasted `border-left`
hacks (P2-14):

```tsx
<Card accent="warn">…</Card>   {/* 3px --status-warn left stripe */}
<Card accent="primary">…</Card>
```

Accent colors are `primary` + the four status tones; the status usage rule
applies to accents too.
