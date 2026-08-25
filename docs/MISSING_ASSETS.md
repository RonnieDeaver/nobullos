# Missing Assets

Last updated: 2026-08-03

---

## Typefaces

### Sweet Sans Pro — RESOLVED via Adobe Fonts / Typekit

**Status:** Available via Typekit CDN. No self-hosted WOFF/WOFF2 files exist in the project (and none are needed — use the CDN embed below).

**Typekit embed link (add to `<head>`):**
```html
<link rel="stylesheet" href="https://use.typekit.net/hve0rhv.css">
```

**CSS family name:** `"sweet-sans-pro", sans-serif`

**Full weight map (non-standard — 600 = Regular, not 400):**

| Weight value | Rendered name | Italic? |
|---|---|---|
| `font-weight: 200` | Extra Thin | normal / italic |
| `font-weight: 300` | Thin | normal / italic |
| `font-weight: 400` | Extra Light | normal / italic |
| `font-weight: 500` | Light | normal / italic |
| `font-weight: 600` | **Regular** | normal / italic |
| `font-weight: 700` | Medium | normal / italic |
| `font-weight: 800` | Bold | normal / italic |
| `font-weight: 900` | Heavy | normal / italic |

**⚠️ Non-standard weight mapping:** `600` = Regular (not Bold as CSS convention expects). Always reference this table when assigning weights — do not assume standard CSS weight names apply.

**Fallback (until Typekit link is added to a page):** Arial. No lookalike substitution (Montserrat, Raleway, etc.) should ever be labelled Sweet Sans Pro.

---

## Other Missing Assets

No other content assets (images, icons, illustrations) are currently missing. All required brand, book, reference, and guideline files have been installed to their canonical locations per `docs/ASSET_MANIFEST.md`.
