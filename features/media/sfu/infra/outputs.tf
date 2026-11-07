output "name" {
  value = digitalocean_droplet.node.name
}

output "public_ip" {
  description = "Keep it out of Git: it goes into the API's CHALK_SFU_NODES and the operator's private notes."
  value       = digitalocean_droplet.node.ipv4_address
  sensitive   = true
}

output "droplet_id" {
  value = digitalocean_droplet.node.id
}
