# Design restyle — dashboard and marketing site, from the ref/ folder

Written 2026-08-13 from seven reference images the founder provided in `ref/`.

**All three gating decisions were taken by the founder the same evening:
blue-led palette (§2 as recommended), photographs leave the marketing site
entirely, and the dashboard goes all the way to the sidebar (Phase B).
Execution started on branch `design/restyle`.**

The references are the สสส physical-activity platform (dashboard + its public
site) and the DeeHub logo sheet. The task as given: the dashboard takes the
mood, tone and style of `dashboard.jpg`; the public site takes the mood and
tone of `web1–5.jpg`; both carry the logo's style from `logo and style.png`.

---

## 1. What the references actually say

Read as a design language rather than as pictures:

### `dashboard.jpg` — the admin surface

- **Warm, not clinical.** The canvas is warm cream, not grey; content sits on
  white cards with large radii (~16px) and shadows so soft they read as paper.
- **Sidebar + slim top bar.** Left rail groups the domain (with two-line Thai/
  English labels and small icons); the active item is a soft tinted pill. Top
  bar: small logo left, quiet horizontal menu, round avatar chip right.
- **Stat tiles on a sunken tint** — pale beige boxes, big colored numbers with
  small unit labels, a corner arrow affordance.
- **Charts are friendly**: horizontal stacked bars with rounded ends, donuts
  with a hole, pale table header bands, generous gaps. Two-color semantics
  (green = good/enough, yellow = not) with blue/purple as secondary series.
- **Type is one rounded Thai sans** at few sizes; headings are quiet, data is
  loud.

### `web1–5.jpg` — the public site

- **Illustration-first, zero photography.** A flat vector scene carries the
  hero (people, trees, paths, a soft city skyline); smaller spot illustrations
  carry sections; an illustration strip sits above the footer.
- **Blobs behind headlines** — rounded color patches (orange/yellow/blue/
  green) stacked behind big display text.
- **A yellow pill CTA** with dark text, and a "scroll" hint under it.
- **Numbered feature cards** (01–04) on pale tinted rounded cards with spot
  art; a saturated blue rounded quote card; a laptop mockup floating over
  color blobs showing the real product; big colorful stat numbers; footer as
  a pale blue band with address, links and the logo.

### `logo and style.png` — the brand

- Mark: a blue **gradient D** (deep navy → bright azure, along the diagonal)
  with a white house cut out of it. Wordmark: **"Dee" in navy, "Hub" in
  azure**; tagline "One Hub. Every Booking." Variants: on-dark card, app icon,
  monochrome.
- The admin app's existing `brand-*`/`ink-*` oklch tokens were already sampled
  from this file and are correct; they stay the single source of hue.

## 2. The one reconciliation this plan makes

The reference dashboard is **green** because สสส's logo is green — their brand
drives their palette. Ours is blue, so the faithful translation is not "copy
the green" but "do what they did": **let the logo drive the palette, and take
everything else — warmth, softness, layout, chart manners — from the
references.**

Concretely: azure replaces the reference's green as the primary; the
reference's **yellow survives as the accent** (it is the natural complement to
blue and the CTA color in `web1`); green narrows to success/positive semantics;
coral/purple appear only as chart series. If the founder would rather clone the
reference palette literally, that is §9 question 1 — but a green DeeHub whose
logo is blue would be a different product wearing the same name.

## 3. Design tokens — one set, both apps

Defined once in each app's token layer (`@theme` in admin-web's globals.css;
`:root` in marketing's site.css), same values:

| Token          | Value                               | From                              |
| -------------- | ----------------------------------- | --------------------------------- |
| `brand-*`      | existing oklch azure ramp           | logo "Hub", mark tip — unchanged  |
| `ink-*`        | existing oklch navy ramp            | logo "Dee", dark card — unchanged |
| `ground`       | `#F7F4EC` warm cream                | dashboard.jpg canvas              |
| `raised`       | `#FFFFFF`                           | cards                             |
| `sunk`         | `#F2EDE1` pale beige                | stat tiles                        |
| `accent`       | `#F5C445` warm yellow               | web1 CTA, chart second series     |
| `success`      | `#17A06B` green                     | ref "เพียงพอ" semantics           |
| `chart series` | azure, yellow, green, coral, plum   | dashboard.jpg + web5              |
| radius         | cards 16px, tiles 12px, pills 999px | both refs                         |
| shadow         | one soft level, barely-there        | both refs                         |
| type           | IBM Plex Sans Thai everywhere       | already bundled in marketing      |

Marketing's current serif (`Noto Serif Thai`) is retired from headings — the
reference's voice is a rounded sans. Thai line-height rules in the current CSS
(`--lh-body: 1.8`, no negative letter-spacing) survive; they exist because Thai
vowel marks clip, and the restyle does not reopen that wound.

## 4. Logo assets

The PNG sheet cannot ship: it is one image containing all variants. Recreate as
SVG — the mark is geometric (a D-form, a house silhouette, four window panes, a
gradient) and traces cleanly:

- `logo-mark.svg`, `logo-lockup.svg` (mark + wordmark + tagline),
  `logo-lockup-dark.svg`, and favicon/app-icon renders (32/180/512).
- Admin-web: replaces the text-only wordmark in the top bar and on the sign-in
  card; `icon.png` and `public/logo.png` replaced by the SVG renders.
- Marketing: header, footer, and og-image get the lockup.
- Gradient stops sampled from the PNG at execution time so the SVG matches the
  sheet, not memory.

## 5. Admin-web — reskin first, restructure second

**Phase A — reskin (no layout change).** The token sweep: `bg-slate-50` ground
becomes cream, remaining slate-on-white cards become white-on-cream with the
larger radius, ~50 files' `slate-*` utilities map to `ink-*`/neutral
equivalents, primary buttons go `ink-900`→`brand-600` hover, active states get
tinted pills, tables get the pale header band, and the reports screens get the
reference's stat-tile treatment (sunken tint, big colored number, unit label).
Charts and meters recolor to the series palette. The 102 Playwright tests
select on roles and text, so a reskin does not touch them.

**Phase B — the sidebar.** The reference's signature is the left rail; the
current app is horizontal tabs (`main-nav.tsx`). Moving property-scoped
navigation into a rail with pill actives, keeping the slim top bar for
logo/property-switcher/account, is a real layout change: every page shifts
left, and e2e specs that scope queries to the nav will need their selectors
verified. Worth doing — it is half the reference's identity — but as its own
commit after A is green, not mixed into the sweep.

## 6. Marketing — a pivot, section by section

The current site is a different aesthetic on purpose ("Direction C — light
editorial": ivory, serif, gold hairline, resort photographs). The reference is
a pivot away from it, and the honest framing is **replacement, not adjustment**:

| Section       | Now                   | Becomes (ref)                                                                             |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Hero          | serif headline, photo | flat illustrated hotel scene, blob-backed headline, yellow pill CTA, scroll hint (`web1`) |
| Problem/story | text + photos         | numbered 01–04 cards, pale tints, spot illustrations (`web5`)                             |
| Product       | screenshots           | laptop mockup floating over color blobs, real dashboard screenshot inside (`web3`)        |
| Numbers       | quiet stats           | big colorful stat figures with Thai units (`web4/5`)                                      |
| Quote/trust   | —                     | saturated blue rounded quote card (`web3`)                                                |
| Footer        | dark editorial        | illustration strip + pale blue contact band + lockup (`web2`)                             |

**Illustrations are the schedule risk.** The reference's scenes are
professional flat vector work. The plan: hand-authored SVG in the same flat
geometric grammar — rounded people, simple trees, soft hills — themed to a
resort (pool, loungers, reception) rather than a park, in the DeeHub palette.
One hero scene, three or four spot illustrations, one footer strip. If the
hand-authored hero does not hold up next to the reference, the fallback is a
blob-and-shapes hero (no figures) with the laptop mockup carrying the visual
weight — still fully inside the reference's language.

The resort photographs leave the site. The 2 MB asset folder shrinks; SVG is
lighter than JPEG.

Both locales (`index.html`, `en/index.html`) move together — the site is two
hand-written pages sharing one stylesheet, and CI already ships them to the
bucket on merge, so **merging is publishing**. Work happens on a branch;
nothing lands on `main` until the founder has seen it.

## 7. Sequence

1. Tokens + logo SVGs (shared foundation, one commit).
2. Marketing pivot on a branch — fastest feedback loop, static HTML, and the
   surface strangers see. Founder reviews on a local preview before merge.
3. Admin Phase A reskin. e2e green before and after.
4. Admin Phase B sidebar. e2e selectors verified.
5. Screenshot pass on both, both locales, mobile widths included.

Rough shape: 1 is small; 2 is the largest single piece (illustrations); 3 is
wide but mechanical; 4 is narrow but careful.

## 8. Risks

| Risk                                                           | Answer                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Hand-authored illustrations look amateur next to the reference | Geometric flat grammar only, few colors, no faces; blob-hero fallback pre-agreed (§6)                             |
| Yellow accent fails contrast                                   | Yellow is never a text color; dark navy text on yellow pills (as the reference does)                              |
| Thai vowel clipping returns with new type sizes                | Keep the existing `--lh-*` rules; they are load-bearing, not styling                                              |
| e2e breakage in the sidebar phase                              | Phase B is isolated, selectors audited in the same commit                                                         |
| Marketing pivot publishes half-done via CI                     | Branch until approved; merge is the launch                                                                        |
| The two apps drift apart again                                 | One token table (§3) both apps copy from; a future `packages/ui` extraction is noted in §10 and not attempted now |

## 9. Three decisions before starting

1. **Palette: blue-led (recommended) or clone the reference's green?** §2 is
   the argument; the logo answers it, but it is the founder's logo.
2. **The resort photographs leave the marketing site entirely — agreed?** The
   reference has no photography at all; keeping both muddies the voice.
3. **Sidebar phase (B): do it, or stop at the reskin?** Full fidelity to the
   reference says do it; it is also the only phase that touches layout and
   e2e.

## 10. Future improvements

- Extract the token table into `packages/ui` once a third surface (the guest
  booking page, roadmap Phase 3) needs it — three copies is the threshold.
- A proper illustration commission to replace the hand-authored SVGs if the
  marketing site earns it; the grammar and palette in this plan make that a
  swap, not a redesign.
- Dark-mode variants of the admin tokens (the logo sheet already defines the
  on-dark treatment) — out of scope here.
