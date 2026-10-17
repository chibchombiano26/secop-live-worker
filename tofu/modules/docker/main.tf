resource "docker_image" "this" {
  name = var.image
}

resource "docker_container" "api" {
  name  = "secop-live-api"
  image = docker_image.this.image_id
  env   = ["API_KEYS=${var.api_keys}"]
  ports {
    internal = 8000
    external = var.api_host_port
  }
  healthcheck {
    test     = ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5)"]
    interval = "30s"
    retries  = 3
  }
  restart = "unless-stopped"
}

resource "docker_container" "mcp" {
  name  = "secop-live-mcp"
  image = docker_image.this.image_id
  env   = ["API_KEYS=${var.api_keys}"]
  ports {
    internal = 8001
    external = var.mcp_host_port
  }
  command = ["python", "-m", "api.mcp_server", "--sse"]
  restart = "unless-stopped"
}
