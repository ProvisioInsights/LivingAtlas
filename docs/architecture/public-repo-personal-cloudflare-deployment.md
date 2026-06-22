# Public Repo And Personal Cloudflare Deployment

Status: Accepted for V1 planning  
Date: 2026-06-21

## Purpose

Define how Living Atlas can be a public repo while also running a private
personal deployment.

The repo should be useful to others as a product/template. The personal
deployment must keep account ids, domains, bootstrap tokens, Terraform state,
Worker secrets, recovery material, and graph data out of public git history.

## Decision

Use a public/private split:

```text
Public LivingAtlas repo
  reusable app code
  reusable Cloudflare IaC module/templates
  example Wrangler config
  example deployment manifests
  docs and tests

Private personal deployment state
  Cloudflare account id
  personal domain/routes
  terraform.tfvars
  Terraform/OpenTofu state
  Wrangler secret values
  bootstrap claim token
  authority-specific config
  recovery material
```

The public repo can build and deploy the product, but it must not contain the
private deployment inputs that make it John's Living Atlas.

## Tooling Model

Use both Terraform/OpenTofu and Wrangler, with clear ownership.

### Terraform/OpenTofu Owns Durable Infrastructure

Use IaC for resources that should be reproducible and reviewable:

- R2 buckets for object custody, segments, manifests, and optional Terraform
  state backend
- D1 database for bootstrap/config/audit metadata where selected
- KV namespaces for small opaque config/session/cache records where selected
- Durable Object bindings/namespaces for first-claim lock and coordination
- Worker routes/custom domains
- Cloudflare Access bootstrap protection, if enabled
- Queues/Analytics/other bindings if added later

The public repo should provide reusable modules and examples. Personal variable
values and state must live outside public git.

### Wrangler Owns Worker Developer Loop And Code Deploy

Use Wrangler for:

- local Worker development
- Worker build/bundle/deploy
- Durable Object migrations when tied to Worker code
- Worker secrets
- environment-specific deploy commands

The public repo can include `wrangler.example.jsonc` or generated config
templates. Personal `wrangler.jsonc`, `.dev.vars`, and secrets stay local or in
a private deployment repo.

Reason: Cloudflare's Worker developer workflow is built around Wrangler, while
Terraform/OpenTofu is better for stable infrastructure shape. Avoid forcing all
Worker code deployment through Terraform in V1.

## Recommended Repo Layout

Future public repo layout:

```text
apps/
  worker/
  web/
  local/

packages/
  contracts/
  crypto/
  policy/
  sync/

infra/
  cloudflare/
    modules/
      living-atlas-single-authority/
    examples/
      single-user/
    README.md

deploy/
  examples/
    cloudflare-single-user/
  personal/              # gitignored; optional local overlay
```

The module should accept variables for names/domains/account ids, but defaults
must be generic and non-personal.

## Personal Deployment Options

### Preferred: Private Deployment Repo

Create a private repo such as:

```text
living-atlas-deploy-personal/
  terraform/
    main.tf
    versions.tf
    backend.tf
    terraform.tfvars
  wrangler/
    wrangler.jsonc
  secrets/
    README.md            # instructions only, not raw secrets
```

That private repo references the public module by Git tag or commit:

```hcl
module "living_atlas" {
  source = "git::https://github.com/<org>/LivingAtlas.git//infra/cloudflare/modules/living-atlas-single-authority?ref=v0.1.0"

  # personal values live in private tfvars
}
```

Benefits:

- public repo stays reusable
- personal deployment can be versioned safely
- Terraform state and tfvars are never in the public repo
- personal deployment can pin a known public commit

### Acceptable: Local Ignored Overlay In The Public Repo

For fast solo development:

```text
deploy/personal/
  terraform.tfvars
  backend.local.hcl
  wrangler.jsonc
  .dev.vars
```

`deploy/personal/` must be gitignored. This is convenient but easier to leak
accidentally than a separate private repo.

## What Must Never Be Public

Never commit:

- Terraform/OpenTofu state files
- `terraform.tfvars`
- backend config containing private bucket/account data
- Cloudflare API tokens
- Worker secrets
- bootstrap claim token or token hash if it can aid attack
- Account Root Key, Authority Key, access-class keys, local-only index keys
- recovery kit or recovery phrase/shares
- authority ids if they can correlate to the personal deployment
- personal domains/routes unless intentionally public
- encrypted graph data if object names/metadata are not proven safe
- local `.living-atlas` profile data

Public examples should use placeholder ids such as `example-authority` and
`living-atlas-example`.

## Bootstrap Token Handling

The deployment command should generate the bootstrap claim token outside git:

```text
living-atlas cloudflare prepare --env personal
  -> generate token locally
  -> store token hash/verification material in Worker secret/config
  -> print token once
  -> write no token to public repo
```

The token may be kept temporarily in a password manager until the first claim
succeeds. After claim, the token is burned and should be deleted.

## Terraform State

Terraform state is sensitive operational metadata.

V1 acceptable state storage:

- private Terraform Cloud/OpenTofu-compatible backend
- encrypted local state for early solo development
- private R2 state bucket created by a separate bootstrap step

Do not store state in the public repo. Do not use the same public deployment
bucket for Terraform state and graph custody unless the state bucket policy,
access token, and retention are deliberately separated.

## Public Template Experience

For other users, the public repo should eventually support:

```text
git clone https://github.com/<org>/LivingAtlas
cd LivingAtlas
npm install
living-atlas deploy init cloudflare
```

That command should:

1. Ask for Cloudflare account/domain choices.
2. Create private local deployment config from examples.
3. Generate a one-time bootstrap claim token.
4. Provision Cloudflare resources through Terraform/OpenTofu.
5. Deploy Worker through Wrangler.
6. Show setup URL and token.
7. Refuse to import real data until bootstrap, recovery, and leakage checks
   pass.

## CI/CD Policy

Public CI may run:

- lint
- typecheck
- unit tests
- fixture leakage tests
- Terraform module validation with dummy values
- Wrangler dry-run/build tests without personal secrets

Personal deployment CI must run only from a private repo/environment and should
use least-privilege Cloudflare API tokens.

Public CI must not deploy the personal Living Atlas.

## Tests

Minimum tests:

- public repo contains no `terraform.tfstate`, `terraform.tfvars`, `.dev.vars`,
  `.env`, or personal overlay files
- example Terraform validates with placeholder values
- personal values are loaded only from ignored/private paths
- deploy command refuses to continue if output paths point into tracked files
- Worker config fixture contains no sensitive keys
- bootstrap token is generated outside git and printed once
- public CI cannot deploy to the personal Cloudflare account

