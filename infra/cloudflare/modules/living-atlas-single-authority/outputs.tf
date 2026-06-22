output "r2_bucket_name" {
  description = "R2 bucket name to bind as LA_GRAPH_BUCKET in Wrangler."
  value       = cloudflare_r2_bucket.graph_custody.name
}

output "d1_database_name" {
  description = "D1 database name to bind as LA_CONTROL_DB in Wrangler."
  value       = cloudflare_d1_database.control_metadata.name
}

output "d1_database_id" {
  description = "D1 database id to bind in Wrangler."
  value       = cloudflare_d1_database.control_metadata.id
}

output "kv_namespace_id" {
  description = "Workers KV namespace id to bind as LA_CONFIG in Wrangler."
  value       = cloudflare_workers_kv_namespace.config.id
}

output "wrangler_binding_names" {
  description = "Binding names expected by packages/cloudflare-worker/wrangler.example.jsonc."
  value = {
    r2_bucket           = "LA_GRAPH_BUCKET"
    d1_database         = "LA_CONTROL_DB"
    kv_namespace        = "LA_CONFIG"
    durable_object_lock = "BOOTSTRAP_CLAIM_LOCK"
  }
}
