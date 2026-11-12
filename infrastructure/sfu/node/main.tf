locals {
  name = "chalk-sfu-${var.environment}"
  # chalk-sfu marks every own-SFU node; the second tag names its environment.
  # The droplet creates them by name, so neither environment's state owns them.
  tags = ["chalk-sfu", var.environment == "production" ? "chalk-sfu-prod" : "chalk-sfu-staging"]
}

data "digitalocean_ssh_key" "operator" {
  name = var.ssh_key_name
}

resource "digitalocean_droplet" "node" {
  name       = local.name
  region     = var.region
  size       = var.size
  image      = "ubuntu-24-04-x64"
  ssh_keys   = [data.digitalocean_ssh_key.operator.id]
  tags       = local.tags
  monitoring = true
  ipv6       = false
  backups    = false

  # Resize CPU and RAM only. A grown disk cannot shrink, and the tier must stay reversible.
  resize_disk = false

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    control_addresses = var.control_addresses
    ssh_addresses     = var.ssh_addresses
    media_port        = var.media_port
  })

  lifecycle {
    # Changing the bootstrap of a live node would replace it and drop its calls.
    # Rebuild a node deliberately with `tofu apply -replace`.
    ignore_changes = [user_data, ssh_keys, image]
  }
}

# The node's ufw mirrors these control and SSH sources: first boot sets it, and
# infrastructure/sfu/deploy matches it to this firewall after every change.
resource "digitalocean_firewall" "node" {
  name        = local.name
  droplet_ids = [digitalocean_droplet.node.id]

  inbound_rule {
    protocol         = "udp"
    port_range       = tostring(var.media_port)
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # A peer whose network blocks UDP reaches the node on the same port over TCP (SFU_TCP_ADDR).
  inbound_rule {
    protocol         = "tcp"
    port_range       = tostring(var.media_port)
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "8443"
    source_addresses = var.control_addresses
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_addresses
  }

  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Media answers peers and TURN relays wherever they are; the host also needs
  # DNS, NTP and package mirrors.
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
