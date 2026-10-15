provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "docker" {}

module "worker" {
  source = "./modules/worker"
  count  = var.enable_cloudflare ? 1 : 0

  worker_name        = var.worker_name
  account_id         = var.cloudflare_account_id
  bundle_path        = var.worker_bundle_path
  api_keys           = var.api_keys
  socrata_app_token  = var.socrata_app_token
  ocr_worker_service = var.ocr_worker_service
  enable_dossiers    = var.enable_dossiers
  dossier_secrets    = var.dossier_secrets
  dossier_vector_index_name = var.dossier_vector_index_name
  custom_hostname    = var.custom_hostname
  zone_id            = var.cloudflare_zone_id
}

module "docker" {
  source = "./modules/docker"
  count  = var.enable_docker ? 1 : 0

  image         = var.docker_image
  api_host_port = var.api_host_port
  mcp_host_port = var.mcp_host_port
  api_keys      = var.api_keys
}

output "worker_url" {
  description = "Public Worker URL (workers.dev)"
  value       = var.enable_cloudflare ? module.worker[0].worker_url : null
}

output "docker_api" {
  description = "Local Docker REST endpoint"
  value       = var.enable_docker ? module.docker[0].api_url : null
}
