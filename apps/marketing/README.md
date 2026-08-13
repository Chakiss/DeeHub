# apps/marketing

`deehubhotel.com` — the public site that sells DeeHub to hotel owners. Plan and
reasoning live in [`docs/marketing-site-plan.md`](../../docs/marketing-site-plan.md).

**Plain static HTML.** No framework, no build step, no server. Two pages (`th`
at the root, `en` under `/en/`), one stylesheet, one script. Everything it needs
is in this folder, so it can be served by anything that serves files.

## Preview

```bash
cd apps/marketing && python3 -m http.server 8899
# http://localhost:8899/      Thai
# http://localhost:8899/en/   English
```

## Layout

```
index.html            Thai
en/index.html         English — a full translation, not a machine pass
assets/css/site.css   all styling; every colour is a token on :root
assets/js/site.js     motion only; the page is complete without it
assets/vendor/        GSAP, ScrollTrigger, Lenis — vendored, see below
assets/fonts/         Noto Serif Thai + IBM Plex Sans Thai, self-hosted
assets/img/           two sizes per image, referenced with srcset
```

## Decisions worth knowing before editing

**Nothing loads from a CDN.** GSAP, ScrollTrigger, Lenis and both typefaces are
served from this folder. A marketing page whose fonts arrive from a third party
hands that party a log of every visitor, and a page whose motion library is a
CDN away is one outage from broken. It also keeps the whole site deployable as a
folder.

**The page is readable with JavaScript off, blocked, or broken.** The class that
hides content for the reveal animation (`js-motion`) is added only after the
script has confirmed GSAP is present and motion is wanted — and it is removed
again if anything throws afterwards. There is no state in which text is hidden
with nothing left running to reveal it.

**`prefers-reduced-motion` is a layout, not a downgrade.** Lenis is not started,
ScrollTrigger is never registered, the custom cursor stays hidden, and every
element sits at its final position.

**Lenis runs on fine pointers only.** Smoothing a touch screen fights the
platform's own inertia and makes a phone feel broken.

**Thai typography has two hard rules** enforced in `site.css`: line-height stays
at or above 1.75, and letter-spacing is never negative. Thai stacks vowels and
tone marks above the x-height; the tight leading and negative tracking a
Latin-first premium design reaches for will clip them.

**ScrollTrigger is refreshed after `document.fonts.ready`.** Trigger positions
measured before the webfonts land are measured against fallback metrics, and
every one of them is wrong after the swap.

## Not done yet

| What                     | Why it is not done                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Real product screenshots | The four `.shot` blocks are labelled placeholders. Capturing them needs a login to the live dashboard.                      |
| Demo form delivery       | Static site, no backend. The form currently composes a mail; set `ENDPOINT` in `site.js` to POST to a form service instead. |
| Photography              | Images are Unsplash placeholders chosen for mood. The first pilot property is the moment to replace them with real ones.    |
| Deployment               | No Terraform yet. It is a folder of files — Cloud Storage behind a CDN, or a Cloud Run service like the others.             |
