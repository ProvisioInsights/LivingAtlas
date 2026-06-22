variable "account_id" {
  description = "Cloudflare account id. Pass through a private tfvars file or TF_VAR_cloudflare_account_id; do not commit personal values."
  type        = string
  sensitive   = true
}

variable "resource_prefix" {
  description = "Generic resource name prefix for this Living Atlas authority."
  type        = string
  default     = "living-atlas-example"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,50}$", var.resource_prefix))
    error_message = "resource_prefix must be lowercase alphanumeric/dash and 3-51 characters."
  }
}

variable "r2_bucket_name" {
  description = "Optional R2 bucket name for encrypted graph custody."
  type        = string
  default     = null
}

variable "d1_database_name" {
  description = "Optional D1 database name for opaque control/audit metadata."
  type        = string
  default     = null
}

variable "kv_namespace_title" {
  description = "Optional KV namespace title for small opaque config/session records."
  type        = string
  default     = null
}
