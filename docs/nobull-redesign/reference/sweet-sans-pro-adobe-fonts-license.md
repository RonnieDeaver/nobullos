# Sweet Sans Pro — licensed via Adobe Fonts (supplied 2026-08-03)

The user supplied the licensed Sweet Sans Pro delivery for the redesign: an
Adobe Fonts (Typekit) hosted kit. No self-hosted WOFF/WOFF2 files exist in the
repo, and none are needed — the license is the hosted kit.

## Kit

```html
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
```

CSS family name: `"sweet-sans-pro", sans-serif`

## Weight map (⚠ NON-STANDARD — read before styling)

The kit maps commercial style names onto CSS weights unusually. In this kit
**`font-weight: 600` is "Sweet Sans Pro Regular"** and 400 is *Extra Light*.
Styling with the usual assumptions (400 = regular, 700 = bold) will render
noticeably lighter than the brand intends.

| Style name              | font-weight | font-style |
|-------------------------|------------:|------------|
| Extra Thin              | 200         | normal     |
| Extra Thin Italic       | 200         | italic     |
| Thin                    | 300         | normal     |
| Thin Italic             | 300         | italic     |
| Extra Light             | 400         | normal     |
| Extra Light Italic      | 400         | italic     |
| Light                   | 500         | normal     |
| Light Italic            | 500         | italic     |
| **Regular**             | **600**     | normal     |
| Italic (Regular)        | 600         | italic     |
| **Medium**              | **700**     | normal     |
| Medium Italic           | 700         | italic     |
| **Bold**                | **800**     | normal     |
| Bold Italic             | 800         | italic     |
| Heavy                   | 900         | normal     |
| Heavy Italic            | 900         | italic     |

Practical guidance for the redesign:
- Body text ("Regular") → `font-weight: 600`.
- Emphasis/semibold ("Medium") → `font-weight: 700`.
- True bold ("Bold") → `font-weight: 800`.
- Tailwind users: the default `font-normal`/`font-bold` utilities (400/700)
  hit *Extra Light*/*Medium* in this kit — define explicit utilities or
  tokens instead of relying on defaults.

## Status

- Import task (#3750) documents the license only; nothing is wired into the
  app yet. Adding the `<link>` tag and typography tokens is redesign work
  (follow-up task #3751).
- The pack's Arial-fallback instruction (used when no license existed) is
  superseded by this kit for the redesign.
