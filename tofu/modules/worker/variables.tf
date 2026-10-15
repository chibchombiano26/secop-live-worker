variable "worker_name" {
  type = string
}
variable "account_id" {
  type = string
}
variable "bundle_path" {
  type = string
}
variable "api_keys" {
  type      = string
  sensitive = true
}
variable "socrata_app_token" {
  type      = string
  sensitive = true
}
variable "custom_hostname" {
  type    = string
  default = ""
}
variable "zone_id" {
  type    = string
  default = ""
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
