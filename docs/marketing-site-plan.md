# DeeHub Marketing Site — Plan

Plan for `deehubhotel.com`, the public site that sells DeeHub to hotel owners.
Written before any code, per `CLAUDE.md`. Nothing here is built yet.

**Audience: hotel owners and managers in Thailand.** Not their guests. The guest
booking page is a separate surface on `book.deehubhotel.com` and is out of scope
here (domain plan below).

---

## 0. The thing to settle first

The brief asks for a cinematic, premium site that conveys **trust** and
**channel-manager professionalism**. The standard vocabulary for that — client
logos, case studies, testimonials, "trusted by N hotels" — is **unavailable**:
DeeHub has zero pilot properties and has never taken a real booking.

That is not a reason to delay the site. It is a reason to build a different kind
of trust. Three sources are real today:

1. **The product itself.** A working dashboard, a real availability calendar, a
   real folio. Screenshots of software that plainly exists outperform a
   testimonial nobody can verify.
2. **The engineering, stated plainly.** No overbooking by construction (a
   database constraint, not a promise), prices frozen at booking, an audit trail
   on every change, Thai-first from day one. Hoteliers have been burnt by
   double-bookings; this is the language of the burn.
3. **Honesty about the stage.** "We are taking our first three partner hotels"
   converts better with early adopters than an implied customer base that a
   five-minute search disproves. The alternative — stock photos of Westerners in
   a lobby, invented logos — is the exact thing that makes a hotelier close the
   tab.

**A fabricated trust signal is the one thing this site must not have.** Everything
else in this plan is negotiable.

---

## 1. Business Goal

Turn a hotel owner who has never heard of DeeHub into a booked conversation.

The measurable outcome is **demo requests**, not signups: the product is not
self-serve yet — a property needs room types, rate plans and inventory set up
before it does anything useful, and a founder-led onboarding is the point at this
stage, not a gap to be automated away.

Secondary: give the founder a URL to send after a conversation, so the pitch
survives the meeting.

---

## 2. Functional Requirements

| #   | Requirement                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- |
| F1  | Single long-scroll page, Thai default, English switchable, language persisted                             |
| F2  | Hero: what DeeHub is, in one sentence a hotelier recognises, plus one primary CTA                         |
| F3  | Problem section: the overbooking / manual-update pain, named specifically                                 |
| F4  | Product proof: real screenshots of calendar, front desk, folio, channel screens                           |
| F5  | Capability sections: PMS, Channel Manager, Booking Engine, Reports — what each does, not a feature matrix |
| F6  | Trust section built from engineering guarantees, not from customer logos                                  |
| F7  | Pricing: a stated position (even "pilot pricing, talk to us"), never silence                              |
| F8  | Demo request form: name, hotel, rooms, phone, email — five fields, no more                                |
| F9  | Sticky secondary CTA to `app.deehubhotel.com` for existing customers signing in                           |
| F10 | Footer: company, contact, PDPA/privacy, English/Thai toggle                                               |

**Explicitly out of scope for v1:** blog, self-serve signup, live chat, pricing
calculator, customer portal, help centre.

---

## 3. Non-functional Requirements

### Motion (the brief's core ask)

| Ask                             | How                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Smooth scroll                   | Lenis, **desktop pointer only** — smoothing native touch scroll makes phones feel broken                                     |
| Scroll choreography             | GSAP + ScrollTrigger, one timeline per section, pinned only where it earns it                                                |
| Layered visuals + parallax      | 2–3 depth layers max, translateY on transform only                                                                           |
| Fades, reveals, image expansion | opacity + transform + `clip-path`; never width/height/top/left                                                               |
| Subtle hover + cursor           | Custom cursor on fine pointers only; hover effects must have a non-hover equivalent                                          |
| Slow, smooth                    | 600–1200ms with long ease-outs — deliberately outside the 150–300ms UI range, because this is narrative motion, not feedback |

**`prefers-reduced-motion` is a first-class layout, not a fallback.** Lenis off,
ScrollTrigger reduced to instant reveals, custom cursor off, every element at its
final state. Someone browsing with motion reduced must get the whole argument.

### Performance

Most Thai hoteliers will open this on a mid-range Android over mobile data. A
cinematic site that takes eight seconds to become useful has communicated
something true about the product.

| Budget           | Target                                                         |
| ---------------- | -------------------------------------------------------------- |
| LCP (mobile, 4G) | < 2.5s                                                         |
| CLS              | < 0.1 — every image gets explicit dimensions                   |
| JS on first load | < 200KB gzip, GSAP included (~70KB)                            |
| Motion libraries | Dynamically imported below the fold; hero renders without them |

Images: AVIF with WebP fallback, `next/image`, responsive `sizes`, lazy below
the fold. Static generation — no request-time rendering; the page has no
per-visitor content.

### Accessibility

Contrast 4.5:1 on body text in both themes (the gold accent is already adjusted
from `#CA8A04` to `#A16207` to clear 3:1 on light). Visible focus rings — a
cinematic site that removes them is unusable by keyboard. Every reveal keeps its
content **in the DOM**, animated only by opacity and transform, so a crawler and
a screen reader both see a normal document.

### SEO

Thai-language search is the acquisition channel; the site is statically
generated for it. `hreflang` th/en, one `h1`, `Organization` + `SoftwareApplication`
structured data, OG images per language.

---

## 4. Database Design

**None.** The site stores nothing and reads nothing. A demo request is delivered
as an email and is not persisted — deliberately, because storing a hotelier's
contact details creates a PDPA obligation for a form that gets a handful of
submissions a week. If demand justifies a CRM later, that is a decision with its
own data-retention answer, not a side effect of building a landing page.

---

## 5. API Design

One route handler inside the marketing app itself:

```
POST /api/demo-request   { name, hotel, rooms, phone, email, website? }
  → 202  { ok: true }
  → 400  { error }  validation
  → 429  { error }  rate limited
```

It sends through **Resend** using `bookings@deehubhotel.com`'s verified domain
(already set up) to the founder's inbox. It does **not** touch the DeeHub API:
the public booking routes are the only unauthenticated surface on that service
and this has no reason to become the second.

**Spam defence: Cloudflare Turnstile.** DNS already lives at Cloudflare, it is
free, and it needs no shared state — which matters because Cloud Run scales
horizontally and an in-memory rate limiter would count per instance and see
nothing (the same reasoning that left the public booking routes unlimited,
`decisions-pending-review.md` §17). A honeypot field backs it up.

---

## 6. Folder Structure

A new app, not a route group inside `admin-web`:

```
apps/marketing/
  src/
    app/
      [locale]/page.tsx          one long page, section components
      api/demo-request/route.ts
    sections/                    hero, problem, product, capabilities, trust, pricing, cta
    motion/
      lenis-provider.tsx         desktop-only, reduced-motion aware
      use-scroll-reveal.ts       the one ScrollTrigger wrapper everything uses
      cursor.tsx
    content/th.ts, en.ts         all copy, no strings in components
  public/media/
```

**Why a separate app:** editing a headline should not redeploy the dashboard.
Different audience, different release cadence, different risk. It scales to zero
on Cloud Run like the others, so the cost of the extra service is roughly zero.

Domain plan it slots into:

```
deehubhotel.com        marketing              ← this plan
www                    301 → apex
app                    dashboard              ✅ live
api                    API                    ✅ live
book                   guest booking engine   ← later, path-based per tenant
```

---

## 7. Implementation Plan

| Step | Deliverable                                                                                 |
| ---- | ------------------------------------------------------------------------------------------- |
| 1    | App skeleton, Tailwind tokens, fonts, Thai/English content files, deployed to a preview URL |
| 2    | Full page **with no motion at all** — the argument must work as a static document first     |
| 3    | Lenis + the single reveal primitive; apply to every section uniformly                       |
| 4    | Hero choreography and image expansion — the two places that carry the cinematic weight      |
| 5    | Cursor and hover polish                                                                     |
| 6    | Form + Turnstile + Resend, tested end to end                                                |
| 7    | Perf pass against the budget, reduced-motion pass, Playwright suite                         |
| 8    | Terraform: Cloud Run service, `deehubhotel.com` + `www` domain mappings, CI deploy          |

Step 2 is the checkpoint that matters. If the page is not persuasive without
motion, motion will not save it — it will only make a weak argument arrive more
slowly.

---

## 8. Test Cases

| #   | Test                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- |
| T1  | With `prefers-reduced-motion: reduce`, every section's text is visible and Lenis is not initialised |
| T2  | No horizontal scroll at 375px, 768px, 1024px, 1440px                                                |
| T3  | Keyboard alone reaches the demo form and submits it; focus is always visible                        |
| T4  | All copy present in server-rendered HTML (crawler and screen-reader safety)                         |
| T5  | Language toggle switches every string and persists across reload                                    |
| T6  | Form: validation errors sit beside their field; success and failure both say what happened          |
| T7  | Turnstile failure and honeypot fill are both rejected server-side                                   |
| T8  | Lighthouse mobile: LCP < 2.5s, CLS < 0.1, a11y ≥ 95                                                 |
| T9  | Thai text at every heading size renders without clipped vowel marks                                 |

---

## 9. Risks

| Risk                                                                                                                    | Severity   | Response                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| **No customers to point at**                                                                                            | **High**   | Section 0. Proof from the product and the engineering; state the stage honestly                             |
| **No photography.** A cinematic site is mostly images and DeeHub owns none                                              | **High**   | Lead with real UI captures; buy a small licensed set for atmosphere; never stock photos posing as customers |
| Thai typography breaks a Latin-first design — vowel marks clip at tight leading, and Thai has no letter-case to lean on | Medium     | Thai-capable faces only; line-height ≥ 1.7; zero negative tracking; T9                                      |
| Cinematic scroll punishes mid-range Android                                                                             | Medium     | Perf budget is a gate, not an aspiration; motion loads below the fold                                       |
| Scroll-driven reveals hide copy from Google                                                                             | Medium     | Content always in the DOM; opacity/transform only; T4                                                       |
| Scope creep — cinematic work expands without a stopping rule                                                            | Medium     | Step 2 is the gate; motion is added to a finished page, never designed with it                              |
| Site outshines the product and the demo disappoints                                                                     | Low–Medium | Screenshots are real, never mockups of unbuilt features                                                     |

---

## 10. Future Improvements

- Case study page, the day the first pilot hotel has numbers worth showing
- Self-serve trial once setup no longer needs a human
- Per-property booking pages on `book.` — the same design language, reused
- Custom domains for hotels (`booking.<hotel>.com`), which needs a load balancer
  (~$18/month) and is a paid tier rather than a default

---

## Decisions needed before step 1

1. **Style direction** — the generated recommendation was "Liquid Glass"; this
   plan proposes dark editorial instead. See the note below.
2. **Pricing position** — a number, a range, or "talk to us". Silence is the one
   option that costs conversions outright.
3. **Photography budget** — licensed imagery, or a product-only visual language.

### Note on the style recommendation

The design-system tool returned **Liquid Glass** (morphing translucency, animated
blur) with the palette and the caveat "Performance: Moderate-Poor". Taking it
would mean stacking heavy `backdrop-filter` on top of GSAP, parallax and Lenis,
for an audience on mobile data — and it argues against the brief's own
"minimal and premium".

Kept from the recommendation: the palette (`#1C1917` / `#A16207` gold /
`#FAFAF9`), the pattern (Trust & Authority → Hero, Proof, Solution, CTA), the
slow-motion instruction, and "avoid cheap visuals".

Rejected: Liquid Glass, and the **Calistoga** heading font — it has no Thai
glyphs at all, so every Thai heading would silently fall back to a system font
and the typography would be decided by whatever device the reader owns.

**Proposed instead:** `Noto Serif Thai` for headings — editorial, premium,
complete Thai coverage — over `IBM Plex Sans Thai` for body, which carries Latin
and Thai in one family with seven weights, so the language toggle does not change
the texture of the page.
