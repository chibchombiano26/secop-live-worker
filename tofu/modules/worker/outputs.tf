output "worker_url" {
  description = "Public workers.dev URL (subdomain from dashboard -> Workers -> your worker)"
  value       = "https://${cloudflare_workers_script.this.script_name}.<account-subdomain>.workers.dev"
}
