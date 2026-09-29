# AI workflow — which model does what

The point is to spend the expensive model on judgement and the cheap models
on volume, without losing the "one AI engineer who knows the codebase"
experience. Written 2026-09-29 after two weeks of running everything on the
top model.

## The ladder

| Tier                    | Model                    | Use it for                                                                                                                                                                            | Not for                                              |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Orchestrator / CTO**  | Fable 5.1 (main session) | Reading a founder's bug report and finding the real cause, architecture and data-model decisions, anything touching production infra or money, planning a PR, unblocking a stuck task | Typing out a feature whose design is already decided |
| **Fast implementation** | Opus 5.5 (`/fast`)       | Large but well-specified changes where speed matters; adversarial review of a diff (`reviewer` agent)                                                                                 | Open-ended exploration                               |
| **Workhorse**           | Sonnet 5 (`builder`)     | Implementing from a plan: use case + endpoint + test, a dashboard component, i18n, e2e adjustments, docs                                                                              | Deciding what to build                               |
| **Scout**               | Haiku 4.5 (`scout`)      | "Where is X", reading logs and long test output, summarising a file, confirming a fact                                                                                                | Anything that edits                                  |

Agent definitions live in `.claude/agents/` (`scout`, `builder`, `reviewer`);
the main session delegates with the Agent tool and keeps the conclusion, not
the file dumps.

## How a typical task should run

1. **Founder reports a problem** (usually screenshots). Main session (Fable)
   asks `scout` for the relevant files, logs and tests, then diagnoses and
   writes a short plan: files, acceptance test, risks. This is the step worth
   the expensive model — a wrong root cause costs a whole day.
2. **`builder` (Sonnet)** implements the plan and runs only the affected test
   files. It reports the changed files and the exact test summary line.
3. **`reviewer` (Opus)** reads the diff before the PR. Findings go back to
   `builder`; the main session only steps in when the two disagree.
4. **Main session** runs the full suites once, opens the PR, watches CI, and
   writes the founder-facing summary in Thai.

For a one-line fix or a doc change, skip the agents: switch the session to
Sonnet with `/model` and do it directly.

## Token hygiene (the part that saves the most)

- **Filter every tool output.** `grep -n`, `tail -40`, `sed -n a,bp` — never
  `cat` a long file or paste a whole log into the conversation. Test runs:
  grep for `×`, `FAIL`, `Tests `, `Test Files` and print `SUITE_EXIT=$?`.
- **Run targeted tests while iterating; the full API suite (900+ tests, ~4
  min) and the full Playwright suite (~2 min) once, before the PR.** CI runs
  them again anyway.
- **Screenshots are expensive.** One phone-width screenshot per feature to
  confirm the layout, not one per iteration. Read the failing assertion text
  first; open the image only when the text does not explain it.
- **Wait cheaply.** A background task plus an `until … sleep` loop costs
  nothing; polling with repeated tool calls does.
- **Compact or clear between unrelated tasks.** A session that has read the
  whole stay view does not need it in context while working on payments.
- **Memory over re-reading.** Facts about how to run things locally live in
  the project memory; do not rediscover them each session.

## What stays on the top model no matter what

Production changes (terraform, secrets, deploys), anything that moves
inventory or money, cross-tenant queries, and the final PR description the
founder reads. The cost of getting those wrong is not measured in tokens.
