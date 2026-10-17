output "worker_url" {
  description = "Public workers.dev URL (subdomain from dashboard -> Workers -> your worker)"
  value       = "https://${cloudflare_workers_script.this.script_name}.<account-subdomain>.workers.dev"
}

output "dossier_database_id" {
  value = var.enable_dossiers ? cloudflare_d1_database.dossiers[0].id : null
}
