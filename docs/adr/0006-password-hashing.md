# ADR-0006: scrypt from node:crypto for password hashing

- **Status:** Accepted
- **Date:** 2026-07-30
- **Decider:** AI (CTO role), pending founder objection

## Context

Passwords need a memory-hard hash. The obvious choice is **Argon2id**, the
current OWASP first recommendation. In Node that means the `argon2` or
`@node-rs/argon2` package — both native modules.

Native modules cost us:

- a pnpm build-script approval and platform binaries;
- build tooling (`python3`, `make`, `g++`) in the Docker builder stage on
  Alpine, which roughly doubles image build time;
- a rebuild risk on every Node upgrade, in a project where AI does the
  upgrades and a native ABI break is an opaque failure.

**scrypt** is also memory-hard, is on the OWASP acceptable list, and ships
inside Node's standard library with zero dependencies.

## Decision

Use `crypto.scrypt` from `node:crypto`, behind a `PasswordHasher` port.

Parameters: **N = 2^15 (32,768), r = 8, p = 1**, 16-byte random salt,
64-byte derived key, stored as `scrypt$N$r$p$salt$hash` so parameters travel
with each hash and can be upgraded per user on next login.

N = 2^15 costs ~32 MB and ~50–100 ms per hash. OWASP suggests 2^17 for
interactive logins, but that is 128 MB per concurrent hash — on Cloud Run
with request concurrency, a burst of logins would OOM the instance. 2^15 with
a strict per-IP login rate limit (10 attempts / 15 min, api-spec.md §7) is
the better trade for this deployment shape.

Comparisons use `crypto.timingSafeEqual`.

## Consequences

- Zero native dependencies: the Docker build stays a plain `node:22-alpine`
  copy, and Node upgrades cannot break the auth path.
- Slightly weaker than a well-tuned Argon2id. Accepted, and mitigated by rate
  limiting, which is the control that actually matters against online
  guessing.
- The stored format carries its parameters, so raising N later — or moving to
  Argon2id if we ever accept a native dependency — is a per-user rehash on
  login, not a migration.
- If a future compliance requirement names Argon2id specifically, only the
  adapter behind `PasswordHasher` changes.
