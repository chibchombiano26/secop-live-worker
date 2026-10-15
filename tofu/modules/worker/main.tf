resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "${var.worker_name}-oauth"
}

resource "cloudflare_workers_script" "this" {
  account_id          = var.account_id
  script_name         = var.worker_name
  content_file        = "${path.root}/${var.bundle_path}"
  content_sha256      = filesha256("${path.root}/${var.bundle_path}")
  main_module         = "bundle.js"
  compatibility_date  = "2026-10-01"
  compatibility_flags = ["global_fetch_strictly_public"]

  bindings = concat([
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
    ], var.enable_dossiers ? [
    { name = "DOSSIER_DB", type = "d1", id = cloudflare_d1_database.dossiers[0].id },
    { name = "DOSSIER_FILES", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.dossiers[0].name },
    { name = "DOSSIER_QUEUE", type = "queue", queue_name = cloudflare_queue.dossiers[0].queue_name },
    { name = "AI", type = "ai" }
  ] : [], var.enable_dossiers && var.ocr_worker_service != "" ? [{ name = "SECOP_OCR", type = "service", service = var.ocr_worker_service }] : [], [for name, value in var.dossier_secrets : { name = name, type = "secret_text", text = value }])
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
