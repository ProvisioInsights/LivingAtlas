provider "cloudflare" {}

variable "cloudflare_account_id" {
  description = "Set privately with TF_VAR_cloudflare_account_id or an ignored tfvars file. Do not commit personal account ids."
  type        = string
  sensitive   = true
}

module "living_atlas" {
  source = "../../modules/living-atlas-single-authority"

  account_id      = var.cloudflare_account_id
  resource_prefix = "living-atlas-example"
}

output "wrangler_bindings" {
  description = "Copy these placeholder values into a private wrangler.jsonc generated from packages/cloudflare-worker/wrangler.example.jsonc."
  value       = module.living_atlas.wrangler_binding_names
}
