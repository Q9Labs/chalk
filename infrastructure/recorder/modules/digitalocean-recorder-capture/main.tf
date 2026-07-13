locals {
  pool_tag        = "chalk-recorder-capture"
  environment_tag = "chalk-environment-${var.environment}"
  digest_tag      = var.image_digest == "" ? "chalk-image-digest-unset" : "chalk-image-${replace(var.image_digest, ":", "-")}"
}

resource "digitalocean_tag" "pool" {
  count = var.enable_apply ? 1 : 0
  name  = local.pool_tag
}

resource "digitalocean_firewall" "capture" {
  count = var.enable_apply ? 1 : 0

  name = "chalk-recorder-capture-${var.environment}"
  # Droplet attachment and desired capacity belong to the external reconciler;
  # keeping this policy unattached prevents a replacement from exceeding caps.
  droplet_ids = []

  # No inbound rule is intentional. Workers poll the control API and upload
  # through short-lived URLs; operators never SSH to a recorder node.
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
    region                 = "sgp1"
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
      error_message = "OpenTofu never mutates capture runtime capacity; external reconciliation owns desired nodes and prewarm."
    }

    precondition {
      condition     = var.max_nodes == 11
      error_message = "capture runtime capacity contract must retain the qualified eleven-node maximum."
    }
  }
}
