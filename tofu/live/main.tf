terraform {
  required_version = ">= 1.13.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.0"
    }
  }
}

# Authentication uses CLOUDFLARE_API_TOKEN; secret values never enter state.
provider "cloudflare" {}

locals {
  deployment = jsondecode(file("${path.module}/../../infra/production.json"))
  account_id = local.deployment.accountId
}

resource "cloudflare_workers_kv_namespace" "kv" {
  for_each   = local.deployment.kv
  account_id = local.account_id
  title      = each.value.title
  lifecycle { prevent_destroy = true }
}
import {
  for_each = local.deployment.kv
  to       = cloudflare_workers_kv_namespace.kv[each.key]
  id       = "${local.account_id}/${each.value.id}"
}

resource "cloudflare_d1_database" "dossiers" {
  account_id = local.account_id
  name       = local.deployment.database.name
  # v5.28 reports computed D1 statistics as an update after import. This live
  # database is intentionally immutable; identity is verified through the API.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}
import {
  to = cloudflare_d1_database.dossiers
  id = "${local.account_id}/${local.deployment.database.id}"
}

resource "cloudflare_r2_bucket" "files" {
  account_id    = local.account_id
  name          = local.deployment.bucket.name
  jurisdiction  = local.deployment.bucket.jurisdiction
  location      = local.deployment.bucket.location
  storage_class = local.deployment.bucket.storageClass
  lifecycle { prevent_destroy = true }
}
import {
  to = cloudflare_r2_bucket.files
  id = "${local.account_id}/${local.deployment.bucket.name}/${local.deployment.bucket.jurisdiction}"
}

resource "cloudflare_queue" "queue" {
  for_each   = local.deployment.queues
  account_id = local.account_id
  queue_name = each.value.name
  settings = {
    delivery_delay           = 0
    message_retention_period = 345600
  }
  lifecycle { prevent_destroy = true }
}
import {
  for_each = local.deployment.queues
  to       = cloudflare_queue.queue[each.key]
  id       = "${local.account_id}/${each.value.id}"
}

# Cron schedules and queue consumers are reconciled through the API. The pinned
# provider cannot faithfully import their existing live representation.
