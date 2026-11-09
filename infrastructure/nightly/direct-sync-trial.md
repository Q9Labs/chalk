# Nightly direct Sync trial (DNS-only path)

This runbook opens a second, temporary path to the nightly Sync origin that skips the Cloudflare
Tunnel, so you can measure what the Tunnel costs a given client link. It is for nightly only and
is never a production configuration. The trial exposes nothing to the internet: the host's
security group admits port 443 only from the tester's own public addresses.

Why it exists: a WebSocket upgrade through the Tunnel costs about 1.8 extra round trips, and every
Sync message pays the Tunnel's longer path. A direct path shows the floor (client to origin
round trip) so a Tunnel setting can be judged against it.

Placeholders: `<zone>` is the nightly zone, `<host-ip>` the nightly host's Elastic IP,
`<host-ipv6>` its IPv6 address, `<sg>` the host security group, `<tester-ipv4>` and
`<tester-ipv6-prefix>` the tester's public addresses. Keep real values out of Git, tickets and
logs.

## Build

1. Allow the tester's addresses. Add one TCP 443 ingress rule per tester IPv4 `/32` and one for the
   tester's IPv6 `/64` (the interface identifier rotates), each with a description naming the
   trial. Never open 443 to `0.0.0.0/0` or `::/0`.
2. Add DNS-only (grey cloud) `A`/`AAAA` records `nightly-sync-direct.<zone>` (and
   `nightly-api-direct.<zone>` if the API is measured) pointing at the host, TTL 60. The host
   address is already public in the recorder control record, so this reveals nothing new.
3. Issue one Let's Encrypt certificate for both names with the DNS-01 challenge, run from the
   tester's machine (`certbot certonly --manual` with hooks that create and delete the
   `_acme-challenge` TXT records). DNS-01 needs no inbound port, so the security group stays
   closed. The cert and key never enter Git.
4. Copy the cert and key to a root-only directory on the host and start a transient Caddy unit
   that terminates TLS and proxies to the existing loopback publishes (Sync `127.0.0.1:14100`,
   API `127.0.0.1:18080`). Use `auto_https off` and `admin off`, and cap the unit's memory so it
   cannot starve the managed containers:

   ```text
   systemd-run --unit=<unit> --property=MemoryMax=100M /opt/<dir>/caddy run --config /opt/<dir>/Caddyfile
   ```

   The managed Quadlet set, images and environment files stay untouched.

5. For IPv6, associate an Amazon IPv6 block with the VPC and subnet, route `::/0` to the internet
   gateway, assign one address to the host interface, and add it to the host with `ip -6 addr add`.
   The VPC has no IPv6 by default. This is tracked drift against the OpenTofu root, so remove it at
   teardown.

## Measure

Run the same phases against the direct and the Tunnel hostname, interleaved on one link, with
fresh connections: DNS, TCP, TLS, request to first byte, WebSocket upgrade, a pre-hello
`ping`/`pong`, then `hello` to `welcome`, `recovery_complete`, and one `set_hand_raised` command to
its `ack`. Use a nightly participant token (an Episode in the nightly proof tenant). Hold the
shared probe lock so a Tunnel tuning lane does not change settings mid-run, and record the Tunnel
state (remote ingress settings, connector uptime) at the start and end of each block.

## Tear down

1. `systemctl stop <unit>`, then delete `/opt/<dir>` on the host.
2. Delete the `nightly-*-direct` DNS records and any leftover `_acme-challenge` TXT records.
3. Delete the 443 ingress rules from the security group.
4. Remove the host IPv6 address, the `::/0` route, the subnet and VPC IPv6 associations.
5. Delete the local certificate directory.

The host reboots clean: none of the host changes persist across a reboot.
