# Contributing to Living Atlas

Living Atlas welcomes contributions that strengthen the private-first graph
model, improve the TypeScript workspace, clarify public documentation, or make
the synthetic validation gates more reliable.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.

## Project Boundaries

Keep contributions aligned with the public repo model:

- Use neutral examples and synthetic fixtures.
- Do not commit real graph data, personal notes, mailbox content, meeting
  records, CRM data, or deployment-specific material.
- Do not commit Cloudflare account values, Terraform/OpenTofu state, tfvars,
  Wrangler secrets, bootstrap or sync tokens, recovery material, private
  domains, or local deployment overlays.
- Treat metadata as potentially sensitive. Paths, manifests, indexes, logs, and
  audit events should avoid names, dates, titles, and other correlating details
  unless the data is explicitly safe for remote use.
- Write active docs in the voice of the Living Atlas project. Avoid process
  transcripts or local workflow history in public-facing docs.

## Development Setup

Use the pinned package manager:

```bash
npx pnpm@11.8.0 install
```

Run the default local gate:

```bash
npm run check
```

For changes that touch local install, Worker routes, sync behavior, policy, or
leakage controls, also run the relevant smoke or stress command:

```bash
npm run smoke:local
npm run stress:local
```

For Cloudflare template or infrastructure changes, run the synthetic preflight
or the narrower infrastructure checks when practical:

```bash
npm run preflight:synthetic
npm run infra:fmt
npm run infra:validate
```

Do not run tests against a real deployment unless you own that deployment and
the test is explicitly designed for live synthetic data.

## Pull Request Expectations

Good pull requests are small, reviewable, and explicit about the security
boundary they touch.

Please include:

- What changed and why.
- Which checks were run.
- Any security, privacy, or metadata-leakage implications.
- Any follow-up work that remains intentionally out of scope.

When changing runtime behavior, prefer tests that exercise contracts, policy
filters, leakage scanning, sync generations, bootstrap behavior, and audit
records with synthetic fixtures. When changing docs, keep public claims precise:
state what is implemented, what is planned, and what remains an open question.

## Documentation Style

- Prefer concrete requirements, validation gates, and examples over broad
  positioning.
- Separate at-rest, in-transit, and in-use security claims.
- Mark open questions clearly.
- Keep public documentation reusable by other deployments.
- Avoid personal names, local paths, private account details, and process
  history that does not help users understand or operate Living Atlas.

## Code Style

Follow the existing TypeScript workspace patterns before adding new
abstractions. Keep public APIs and schemas explicit, validate structured data at
boundaries, and keep comments focused on non-obvious decisions.

TypeScript 7 is the workspace compiler. Treat the `typescript` package as the
CLI/compiler dependency for `tsc`, not as a stable in-process API in active
source. Runtime TypeScript execution should go through `tsx`, and simple
browser/workbench transforms should use `esbuild`. If a future codemod or code
generation tool needs compiler APIs, isolate that behind a deliberate dev-only
adapter and document whether it uses TypeScript 7 unstable APIs or a pinned
compatibility package.

If a contribution changes how data is classified, encrypted, synced, indexed,
logged, or exposed through MCP, treat it as security-sensitive and update tests
or documentation in the same pull request.
