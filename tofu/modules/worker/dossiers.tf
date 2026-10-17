resource "cloudflare_d1_database" "dossiers" {
  count      = var.enable_dossiers ? 1 : 0
  account_id = var.account_id
  name       = "${var.worker_name}-dossiers"
}
resource "cloudflare_r2_bucket" "dossiers" {
  count      = var.enable_dossiers ? 1 : 0
  account_id = var.account_id
  name       = "${var.worker_name}-dossiers"
}
resource "cloudflare_queue" "dossiers" {
  count      = var.enable_dossiers ? 1 : 0
  account_id = var.account_id
  queue_name = "${var.worker_name}-dossiers"
}
resource "cloudflare_queue" "dossier_dead_letter" {
  count      = var.enable_dossiers ? 1 : 0
  account_id = var.account_id
  queue_name = "${var.worker_name}-dossier-dead-letter"
}
resource "cloudflare_queue_consumer" "dossiers" {
  count             = var.enable_dossiers ? 1 : 0
  account_id        = var.account_id
  queue_id          = cloudflare_queue.dossiers[0].id
  script_name       = cloudflare_workers_script.this.script_name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.dossier_dead_letter[0].queue_name
  settings = {
    batch_size       = 1
    max_concurrency  = 2
    max_retries      = 5
    max_wait_time_ms = 1000
  }
}
resource "cloudflare_workers_cron_trigger" "dossiers" {
  count       = var.enable_dossiers ? 1 : 0
  account_id  = var.account_id
  script_name = cloudflare_workers_script.this.script_name
  schedules   = [{ cron = "* * * * *" }]
}
