# Private Cloudflare Deployment Overlay Repo

Status: Recommended V1 deployment pattern

## Purpose

LivingAtlas should remain a reusable public project. A personal Cloudflare
deployment needs private operational inputs that do not belong in the public
repo: Cloudflare account ids, zone ids, route names, Terraform/OpenTofu variable
values, backend state configuration, Wrangler personal config, secret
references, and environment-specific overlays.

The recommended pattern is a separate private deployment overlay repo. The
public LivingAtlas repo defines the reusable product, interfaces, modules,
tests, examples, and placeholder configuration. The private overlay repo binds
those reusable pieces to one operator's Cloudflare account and environments.

This keeps the public repo cloneable and useful by other operators while
protecting the private deployment from accidental publication.

## Recommendation

Create a private repo such as:

```text
living-atlas-cloudflare-overlay/
```

That repo should pin the public LivingAtlas repo by Git tag or commit, then
provide only the private values and runbooks required to deploy the operator's
environments.

The private overlay repo may contain references to secret names and secret-store
locations. It must not contain raw Cloudflare API tokens, bootstrap claim
tokens, recovery material, plaintext graph data, unwrapped keys, or local
profile state.

## Suggested Private Repo Layout

```text
living-atlas-cloudflare-overlay/
  README.md
  RUNBOOK.md
  versions.lock

  terraform/
    README.md
    versions.tf
    main.tf
    providers.tf
    backend.example.hcl
    envs/
      personal-dev/
        backend.hcl
        terraform.tfvars
      personal-prod/
        backend.hcl
        terraform.tfvars

  wrangler/
    README.md
    envs/
      personal-dev/
        wrangler.jsonc
      personal-prod/
        wrangler.jsonc

  secrets/
    README.md
    secret-map.example.yaml
    envs/
      personal-dev.secret-refs.yaml
      personal-prod.secret-refs.yaml

  overlays/
    personal-dev/
      deploy.env.example
      resource-names.md
    personal-prod/
      deploy.env.example
      resource-names.md

  scripts/
    plan.sh
    apply.sh
    deploy-worker.sh
    smoke.sh
```

`versions.lock` should record the public LivingAtlas Git ref and any tool
versions used for a successful deployment:

```text
living_atlas_ref = "v0.1.0"
terraform_version = "1.x"
wrangler_version = "x.y.z"
node_version = "x.y.z"
```

Use placeholder values in examples. Real values belong only in private overlay
files, local environment variables, Cloudflare secret storage, or an external
password manager.

## Exact Public/Private Boundary

| Surface | Public LivingAtlas repo | Private overlay repo |
| --- | --- | --- |
| App and Worker code | Reusable source code, tests, contracts, and package config | None, except pinned public Git ref |
| Terraform/OpenTofu | Reusable modules, example root modules, validation fixtures, placeholder variables | Root module wiring, backend config, `terraform.tfvars`, environment-specific values |
| Wrangler | Example `wrangler` templates and documented required bindings | Personal `wrangler.jsonc` per environment |
| Cloudflare account data | Variable names only, never real account ids or zone ids | Account ids, zone ids, route names, custom hostnames, resource name choices |
| Secrets | Required secret names, schemas, and local setup instructions | Secret references and secret-store locations; no raw secret values |
| Terraform state | No state files, no backend credentials, no real backend config | Backend config and state location policy; state file should still live in the configured private backend, not git |
| Deploy runbook | Generic deploy flow and safety checks | Exact operator runbook for each environment |
| Environment overlays | Placeholder examples only | `personal-dev`, `personal-prod`, or other real environment overlays |
| Graph data | Synthetic fixtures only | No graph data by default; real imports should come from local runtime flows, not deployment git |
| Recovery material | Interface and policy docs only | References to external recovery storage; no recovery phrases or shares in git |

The public repo must be able to run checks, build artifacts, validate example
infrastructure, and run synthetic leakage tests without any private overlay. It
must not require the operator's Cloudflare account to be useful.

The private overlay repo must not fork product behavior. It should configure
deployment targets and environment-specific resources, not redefine
LivingAtlas contracts.

## Private Terraform/OpenTofu Inputs

The private overlay repo may own:

- `terraform.tfvars` for each environment.
- `backend.hcl` for each environment.
- Resource names for R2 buckets, D1 databases, KV namespaces, Durable Object
  namespaces, Queues, Access policies, routes, and observability sinks.
- Cloudflare account and zone identifiers.
- Route and hostname choices.
- Least-privilege deploy token references.

Example private root module shape:

```hcl
module "living_atlas" {
  source = "git::https://example.invalid/org/LivingAtlas.git//infra/cloudflare/modules/living-atlas-single-authority?ref=v0.1.0"

  account_id      = var.cloudflare_account_id
  zone_id         = var.cloudflare_zone_id
  environment     = var.environment
  worker_name     = var.worker_name
  r2_bucket_name  = var.r2_bucket_name
  d1_database     = var.d1_database
  kv_namespace    = var.kv_namespace
  route_hostname  = var.route_hostname
}
```

The example URL is intentionally non-routable. Replace it inside the private
repo with the real public LivingAtlas source once the public module path exists.

## Private Wrangler Inputs

The private overlay repo may own one Wrangler config per environment. These
files bind a public Worker build to personal Cloudflare resources.

```jsonc
{
  "name": "living-atlas-personal-dev",
  "main": "../../LivingAtlas/apps/worker/src/index.ts",
  "compatibility_date": "2026-01-01",
  "account_id": "<private-account-id>",
  "routes": [
    { "pattern": "<private-hostname>", "custom_domain": true }
  ],
  "vars": {
    "LIVING_ATLAS_ENV": "personal-dev"
  }
}
```

This file is private because it can expose account identifiers, resource names,
routes, and environment topology. It still must not contain raw secrets.

## Secret References

Secret reference files can document where secrets live and which deploy step
uses them:

```yaml
environment: personal-dev
cloudflare_api_token:
  store: password-manager
  item: living-atlas-cloudflare-api-token
bootstrap_claim_token_hash:
  store: cloudflare-worker-secret
  name: BOOTSTRAP_CLAIM_TOKEN_HASH
sync_token_signing_key:
  store: cloudflare-worker-secret
  name: SYNC_TOKEN_SIGNING_KEY
```

These are references, not secret values. Raw tokens, signing keys, bootstrap
claim tokens, recovery shares, local profile secrets, and unwrapped graph keys
must stay in a password manager, Cloudflare secret storage, hardware-backed
keychain, or another approved secret store.

## Deploy Runbook

The private `RUNBOOK.md` should describe exact operator steps without copying
secrets into git:

1. Select environment: `personal-dev` or `personal-prod`.
2. Confirm `versions.lock` points to the intended public LivingAtlas ref.
3. Run public repo checks at that ref.
4. Verify the private Terraform backend config points to the intended state
   backend.
5. Run `terraform init -backend-config=envs/<env>/backend.hcl`.
6. Run `terraform plan -var-file=envs/<env>/terraform.tfvars`.
7. Apply infrastructure only after reviewing resource names and routes.
8. Set or rotate Wrangler secrets from the approved secret store.
9. Deploy the Worker with the environment's private `wrangler.jsonc`.
10. Run deployment smoke checks.
11. Record the public LivingAtlas ref, plan/apply summary, Worker version, and
    smoke result in the private repo's deployment log.

The runbook should also define rollback, secret rotation, bootstrap token burn,
state recovery, and emergency route-disable procedures.

## Guardrails

- Public CI must never deploy a personal Cloudflare environment.
- Public CI may validate placeholder Terraform and Wrangler examples only.
- Private CI, if used, must run from the private overlay repo and use
  least-privilege Cloudflare API tokens.
- `terraform.tfstate`, `.terraform/`, `.dev.vars`, raw `.env` files, and
  secret material must be ignored in both repos.
- Environment overlays must not include real graph exports or local
  `.living-atlas` profile data.
- Remote storage names and object paths must still pass the metadata leakage
  budget before real graph import.
- The deployment stays sealed until the one-time bootstrap claim path is
  configured and tested.

## Public Template Contract

LivingAtlas should expose enough public structure for another operator to build
their own private overlay:

- documented Terraform variables and outputs
- example placeholder `terraform.tfvars`
- example placeholder backend config
- example Wrangler template
- required Worker secret names and meanings
- synthetic deploy and leakage tests
- bootstrap claim flow documentation

The public repo should not include the recommended operator's actual overlay
repo contents. It should include only the shape and contract needed to create a
new private overlay.
