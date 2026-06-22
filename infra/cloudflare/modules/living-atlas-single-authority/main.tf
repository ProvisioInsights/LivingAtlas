locals {
  r2_bucket_name     = coalesce(var.r2_bucket_name, "${var.resource_prefix}-graph")
  d1_database_name   = coalesce(var.d1_database_name, "${var.resource_prefix}-control")
  kv_namespace_title = coalesce(var.kv_namespace_title, "${var.resource_prefix}-config")
}

resource "cloudflare_r2_bucket" "graph_custody" {
  account_id = var.account_id
  name       = local.r2_bucket_name
}

resource "cloudflare_d1_database" "control_metadata" {
  account_id = var.account_id
  name       = local.d1_database_name

  lifecycle {
    ignore_changes = [
      read_replication
    ]
  }
}

resource "cloudflare_workers_kv_namespace" "config" {
  account_id = var.account_id
  title      = local.kv_namespace_title
}
