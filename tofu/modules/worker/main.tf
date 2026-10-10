resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "${var.worker_name}-oauth"
}

resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.worker_name
  content            = file("${path.root}/${var.bundle_path}")
  main_module        = "bundle.js"
  compatibility_date = "2026-10-01"
  compatibility_flags = ["global_fetch_strictly_public"]

  bindings = [
    {
      name = "API_KEYS"
      type = "secret_text"
      text = var.api_keys
    },
    {
      name = "SOCRATA_APP_TOKEN"
      type = "secret_text"
      text = var.socrata_app_token
    },
    {
      name         = "OAUTH_KV"
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.oauth.id
    },
  ]
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.this.script_name
  enabled     = true
}

resource "cloudflare_workers_custom_domain" "this" {
  count      = var.custom_hostname != "" ? 1 : 0
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.custom_hostname
  service    = cloudflare_workers_script.this.script_name
}
