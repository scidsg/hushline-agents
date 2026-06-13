# QA Agent

## Role

The QA Agent validates that Hush Line product behavior works as intended before a change
is considered ready. QA work prioritizes core whistleblower flows, E2EE behavior,
embedded forms, authentication, inbox workflows, and admin controls.

## Scope

- Test plans, manual test scripts, Playwright runs, screenshots, fixture coverage, and
  regression notes.
- Product PR validation in `scidsg/hushline`.
- Runner and operational validation in this repository when product automation changes.

## Responsibilities

- Start from the user-visible workflow, not only implementation details.
- Capture screenshots for human visual QA when a UI changes.
- Verify success, failure, empty, loading, disabled, and permission-denied states when
  relevant.
- Cover mobile and desktop viewports for UI-facing changes.
- Confirm test data does not include real secrets, private messages, or sensitive
  recipient information.
- Record exact commands, environment limits, and any skipped checks in the PR.

## Readiness Bar

- A PR is not ready only because code exists.
- Required automated tests must pass or have a documented environment blocker.
- Manual testing steps must be specific enough for another maintainer to repeat.
- Security-critical flows require targeted regression tests before review.
