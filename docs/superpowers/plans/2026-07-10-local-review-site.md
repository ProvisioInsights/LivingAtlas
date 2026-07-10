# Local Atlas Review Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authenticated, local-only browser review surface that reads canonical Atlas records and applies only atomic review decisions.

**Architecture:** Add a `@living-atlas/local-review-site` Node server bound solely to `127.0.0.1`. It receives a prebuilt authenticated `LocalMcpContext` in tests/runtime, projects decrypted canonical review/evidence/parity data in memory per request, and delegates mutations exclusively to `localResolutionApply`; it writes no browser/server database or source payload.

**Tech Stack:** TypeScript ESM, Node HTTP, esbuild, Vitest, local MCP, graph-service projections.

## Global Constraints

- Bind only to loopback; reject requests without a local Bearer token before plaintext projection.
- Browser API responses may contain local-private content only after the authenticated local boundary.
- Owner queue contains only `owner-review`; research and auto-applied/resolved items remain separately inspectable.
- Every approve/edit/merge/research/defer action sends one candidate’s full `resolution_apply` request; bulk actions are only a visible list of independent atomic candidate commands.
- Do not create a database, emit legacy source payloads, add remote endpoints, host, push, deploy, or access a real profile.

---

### Task 1: Project Authenticated Review Data

**Files:**
- Create: `packages/local-review-site/src/review-projection.ts`
- Create: `packages/local-review-site/src/review-projection.test.ts`

**Interfaces:**
- Produces `projectLocalReviewQueue({ objects, decryptPayload })` with `owner_review`, `research`, and `automatic` buckets.
- Each item carries its review payload, proposed canonical records, evidence, parity records, dependency ids, and an explicit `missing_references` list—never a source/page/block payload.

- [ ] **Step 1: Write failing synthetic projection tests**

Use encrypted review, evidence, observation, and parity objects. Assert the owner bucket contains only `resolution_state: "owner-review"`; research and `auto-applied` appear in separate buckets; referenced evidence/parity/observation ids resolve into the item while a missing id is reported, not invented.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement narrow canonical projection**

Decrypt only envelope types `review`, `evidence`, `assertion`, `edge`, `entity`, and `manifest`; parse their canonical contracts and join by canonical ids. Reject/ignore legacy types before decrypt. Return no raw source context until an Atlas-native migration-context record exists; report `context_unavailable` instead.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts`

Commit: `git commit -m "Add canonical local review projection (#18)"`

### Task 2: Serve Loopback-Authenticated Review API and UI

**Files:**
- Create: `packages/local-review-site/src/server.ts`
- Create: `packages/local-review-site/src/server.test.ts`
- Create: `packages/local-review-site/src/index.html`
- Create: `packages/local-review-site/src/app.ts`
- Create: `packages/local-review-site/src/styles.css`
- Create: `packages/local-review-site/package.json`

**Interfaces:**
- `createLocalReviewSiteServer({ context, authorizationHeader? })` serves `GET /api/review-queue` and `POST /api/review/:candidate_id/apply` only on loopback.
- The apply route injects authorization and delegates the validated body to `localResolutionApply`; it never writes graph objects itself.

- [ ] **Step 1: Write failing server tests**

Assert no authorization returns 401 without queue content; valid local authorization returns only the owner queue; an apply request calls the atomic local service and returns its custody receipt; a non-owner review candidate is rejected. Assert `listen` uses `127.0.0.1` in the executable entry point.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/local-review-site/src/server.test.ts`

Expected: FAIL because the server module does not exist.

- [ ] **Step 3: Implement server and focused UI**

The HTML app renders filter tabs for Owner review, Research, and Automatic. Owner cards show proposed records, evidence, parity, dependencies, missing-context state, and explicit bulk effect count. The only mutation button posts a complete precomputed resolution request. Browser state is ephemeral fetch state only.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/local-review-site/src/server.test.ts packages/local-review-site/src/review-projection.test.ts`

Commit: `git commit -m "Add authenticated local review site (#18)"`

### Task 3: Verify and Track #18

- [ ] **Step 1: Run boundary audit and full gate**

```bash
rg -n 'fetch\(.*https|Cloudflare|logseq-|object_type: "page"|object_type: "block"' packages/local-review-site
pnpm check
```

Expected: no remote/legacy source path; all tests pass.

- [ ] **Step 2: Update #18 and #43 with public-safe evidence, then commit locally**

Keep #18 In Progress until the final synthetic gates and isolated-copy run; do not push or deploy.
