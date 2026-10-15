variable "enable_cloudflare" {
  description = "Deploy the Worker to Cloudflare"
  type        = bool
  default     = true
}

variable "enable_docker" {
  description = "Run the Docker version (secop-live image) locally"
  type        = bool
  default     = false
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Workers edit + zones read). Never commit."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker"
  type        = string
  default     = ""
}

variable "worker_name" {
  description = "Worker script name"
  type        = string
  default     = "secop-live-worker"
}

variable "custom_hostname" {
  description = "Optional custom domain (must be in a Cloudflare zone). Empty = workers.dev only."
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Zone ID for custom_hostname (required if set)"
  type        = string
  default     = ""
}

variable "worker_bundle_path" {
  description = "Built worker bundle, relative to tofu/ root (npm run bundle in worker/)"
  type        = string
  default     = "../worker/dist/bundle.js"
}

variable "api_keys" {
  description = "Comma-separated API keys for the Worker"
  type        = string
  sensitive   = true
  default     = ""
}

variable "socrata_app_token" {
  description = "Optional Socrata app token (higher rate limits)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "docker_image" {
  description = "Published secop-live image for the Docker version"
  type        = string
  default     = "ghcr.io/chibchombiano26/secop-live:latest"
}

variable "api_host_port" {
  description = "Host port for the Docker REST API"
  type        = number
  default     = 8100
}

variable "mcp_host_port" {
  description = "Host port for the Docker MCP SSE"
  type        = number
  default     = 8101
}
variable "enable_dossiers" {
  type    = bool
  default = false
}
variable "dossier_secrets" {
  type      = map(string)
  default   = {}
  sensitive = true
}
