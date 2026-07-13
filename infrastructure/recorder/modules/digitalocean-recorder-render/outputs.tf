output "droplet_ids" {
  value = []
}

output "droplet_names" {
  value = []
}

output "firewall_id" {
  value = try(digitalocean_firewall.render[0].id, null)
}
