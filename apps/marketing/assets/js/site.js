/*
 * DeeHub marketing site — motion layer.
 *
 * Everything here is ADDITIVE. The page is complete and readable with this file
 * blocked, failing, or switched off by prefers-reduced-motion: the hiding class
 * (`js-motion`) is only applied once we have decided to animate, so nothing can
 * end up invisible with no script left to reveal it.
 */

(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  /* ---------------------------------------------------------------- nav */

  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-stuck', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* --------------------------------------------------------------- form
     No backend: this is a static site. Until an endpoint is configured the
     form composes a mail instead of failing silently — a form that appears to
     submit and does nothing is worse than no form. */

  var ENDPOINT = ''; // set to a form service URL to POST instead of mailto
  var INBOX = 'hello@deehubhotel.com';

  var form = document.querySelector('.form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      if (data.get('website')) return; // honeypot: bots fill hidden fields

      var required = ['name', 'hotel', 'phone', 'email'];
      for (var i = 0; i < required.length; i++) {
        var field = form.elements[required[i]];
        if (!field.value.trim() || !field.checkValidity()) {
          field.focus();
          field.setAttribute('aria-invalid', 'true');
          return;
        }
        field.removeAttribute('aria-invalid');
      }

      if (ENDPOINT) {
        fetch(ENDPOINT, { method: 'POST', body: data });
        return;
      }

      var lines = [];
      data.forEach(function (value, key) {
        if (key !== 'website') lines.push(key + ': ' + value);
      });
      window.location.href =
        'mailto:' +
        INBOX +
        '?subject=' +
        encodeURIComponent('ขอเดโม DeeHub — ' + data.get('hotel')) +
        '&body=' +
        encodeURIComponent(lines.join('\n'));
    });
  }

  if (reduced || !hasGsap) return;

  /* ------------------------------------------------------------- cursor */

  if (fine) {
    var cursor = document.querySelector('.cursor');
    if (cursor) {
      var x = window.gsap.quickTo(cursor, 'x', { duration: 0.5, ease: 'power3' });
      var y = window.gsap.quickTo(cursor, 'y', { duration: 0.5, ease: 'power3' });
      window.addEventListener(
        'pointermove',
        function (e) {
          cursor.classList.add('is-on');
          x(e.clientX);
          y(e.clientY);
        },
        { passive: true },
      );
      document.querySelectorAll('a, button, input, select').forEach(function (el) {
        el.addEventListener('pointerenter', function () {
          cursor.classList.add('is-over');
          window.gsap.to(cursor, { scale: 1.9, duration: 0.4, ease: 'power3' });
        });
        el.addEventListener('pointerleave', function () {
          cursor.classList.remove('is-over');
          window.gsap.to(cursor, { scale: 1, duration: 0.4, ease: 'power3' });
        });
      });
    }
  }

  /* ------------------------------------------------------- smooth scroll
     Desktop pointers only. Smoothing a touch screen fights the platform's own
     inertia and makes a phone feel broken. */

  if (fine && typeof window.Lenis !== 'undefined') {
    var lenis = new window.Lenis({ duration: 1.15, wheelMultiplier: 0.9 });
    lenis.on('scroll', window.ScrollTrigger.update);
    window.gsap.ticker.add(function (t) {
      lenis.raf(t * 1000);
    });
    window.gsap.ticker.lagSmoothing(0);

    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var target = document.querySelector(a.getAttribute('href'));
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -90 });
      });
    });
  }

  /* ------------------------------------------------------------ reveals */

  /* From here on the page is hiding content that only script will bring back.
     If anything throws in between, every reveal stays invisible forever — so
     the whole block is guarded, and the guard undoes the hiding. */
  document.documentElement.classList.add('js-motion');

  window.addEventListener('error', unhide);
  function unhide() {
    document.documentElement.classList.remove('js-motion');
    try {
      window.gsap.set('[data-reveal],[data-clip]', { clearProps: 'all' });
    } catch (ignored) {
      /* the class is already off; inline styles are the lesser problem */
    }
  }

  try {
    build();
  } catch (err) {
    unhide();
    throw err;
  }

  function build() {
    window.gsap.registerPlugin(window.ScrollTrigger);

    var EASE = 'power3.out';

    /* Two ways a reveal can never fire, both of which leave text permanently
       invisible on a page whose whole job is to be read. Both were observed
       before these lines existed.

       1. Lenis intercepts the wheel, so `lenis.on('scroll')` is the only thing
          driving ScrollTrigger — and a native scroll (space bar, PageDown,
          dragging the scrollbar, the browser restoring a position on reload)
          never goes through Lenis. Scrolling to the bottom with the keyboard
          left 28 of 39 blocks at opacity 0.
       2. Trigger positions are measured before the webfonts arrive. Thai and
          Latin fall back to different metrics, the page reflows on swap, and
          every start/end point computed beforehand is wrong. */
    window.addEventListener('scroll', window.ScrollTrigger.update, { passive: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        window.ScrollTrigger.refresh();
      });
    }

    // Hero: everything above the fold plays on load, staggered, no trigger.
    var heroBits = document.querySelectorAll('.hero [data-reveal]');
    window.gsap.to(heroBits, {
      opacity: 1,
      y: 0,
      duration: 1.1,
      ease: EASE,
      stagger: 0.09,
      delay: 0.15,
    });

    var heroFigure = document.querySelector('.hero [data-clip]');
    if (heroFigure) {
      window.gsap.to(heroFigure, {
        clipPath: 'inset(0 0 0% 0)',
        duration: 1.5,
        ease: 'power4.out',
        delay: 0.25,
      });
    }

    // Everything below the fold reveals as it arrives.
    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      if (el.closest('.hero')) return;
      window.gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 1,
        ease: EASE,
        scrollTrigger: { trigger: el, start: 'top 86%', once: true },
      });
    });

    // Parallax: two or three layers, small distances, transform only.
    document.querySelectorAll('[data-parallax]').forEach(function (el) {
      var depth = parseFloat(el.getAttribute('data-parallax')) || 0.1;
      window.gsap.to(el, {
        yPercent: depth * -100,
        ease: 'none',
        scrollTrigger: {
          trigger: el.parentElement || el,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
        },
      });
    });

    // The band image widens to full bleed as it crosses the viewport.
    var band = document.querySelector('[data-expand]');
    if (band) {
      window.gsap.fromTo(
        band,
        { width: 'min(1180px, 100% - 40px)' },
        {
          width: '100%',
          ease: 'none',
          scrollTrigger: { trigger: band, start: 'top 82%', end: 'top 24%', scrub: true },
        },
      );
    }
  }
})();
