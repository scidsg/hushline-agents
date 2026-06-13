# AGENTS.md

Product agents support the Hush Line application, product operations, and product-facing
automation. The product safety priorities from `scidsg/hushline` apply here: preserve
whistleblower anonymity, confidentiality, integrity, availability, receiver authenticity,
and plausible deniability.

## Scoped Agents

- Code Agent: `agents/product/code/`
  - Owns the GitHub issue implementation runner, local bootstrap helper, run-log
    sanitizer, code-agent policy, operational docs, and tests.
  - May prepare product PRs in `scidsg/hushline`, but product changes require human
    review and protected checks before merge.
- Reporting Agent: `agents/product/reporting/`
  - Owns weekly local runner reporting and tests.
- Accessibility Agent: `AGENTS.A11Y.md`
  - Reviews product experience for accessibility and WCAG-aligned behavior.
- QA Agent: `AGENTS.QA.md`
  - Plans and verifies end-to-end product behavior, regression coverage, and human
    visual QA evidence.
- Security Agent: `AGENTS.SEC.md`
  - Reviews security, privacy, E2EE, origin validation, secrets handling, and abuse
    controls.

## Product Operating Rules

- Treat Hush Line as safety-critical whistleblowing infrastructure.
- Do not weaken encryption defaults, anonymity protections, CSP, origin validation,
  signed commits, branch protection, or dependency-audit requirements.
- Keep generated runner logs out of Git unless explicitly sanitized and intended as
  evidence.
- Update docs when an agent workflow, schedule, role, or operational contract changes.
- Social automation is a peer scope under `agents/social/`, not a child of product.
