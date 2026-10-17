variable "image" {
  type = string
}
variable "api_host_port" {
  type = number
}
variable "mcp_host_port" {
  type = number
}
variable "api_keys" {
  type      = string
  sensitive = true
  default   = ""
}
