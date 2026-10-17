output "api_url" {
  description = "Local Docker REST endpoint"
  value       = "http://localhost:${var.api_host_port}"
}
