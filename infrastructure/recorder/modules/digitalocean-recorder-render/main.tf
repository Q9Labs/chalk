locals {
  pool_tag        = "chalk-recorder-render"
  environment_tag = "chalk-environment-${var.environment}"
  digest_tag      = var.image_digest == "" ? "chalk-image-digest-unset" : "chalk-image-${replace(var.image_digest, ":", "-")}"
}

resource "digitalocean_tag" "pool" {
  count = var.enable_apply ? 1 : 0
  name  = local.pool_tag
}

resource "digitalocean_firewall" "render" {
  count = var.enable_apply ? 1 : 0

  name = "chalk-recorder-render-${var.environment}"
  # Droplet attachment and desired capacity belong to the external reconciler;
  # keeping this policy unattached prevents a replacement from exceeding caps.
  droplet_ids = []

  # No inbound rule is intentional. Renderers poll the control API and read
  # only the job-scoped encrypted input URLs they receive.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "443"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "123"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "3478-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "terraform_data" "runtime_capacity_contract" {
  input = {
    pool                   = local.pool_tag
    region                 = "tor1"
    max_nodes              = var.max_nodes
    desired_nodes          = var.desired_nodes
    node_size              = var.node_size
    immutable_image_id     = var.image_id
    immutable_image_digest = var.image_digest
    bootstrap_endpoint     = var.bootstrap_endpoint
    runtime_owner          = "external-recorder-reconciler"
  }

  lifecycle {
    precondition {
      condition     = var.desired_nodes == 0
      error_message = "OpenTofu never mutates render runtime capacity; external reconciliation owns scale-to-zero and deadline admission."
    }

    precondition {
      condition     = var.max_nodes == 10
      error_message = "render runtime capacity contract must retain the qualified ten-node maximum."
    }
  }
}
