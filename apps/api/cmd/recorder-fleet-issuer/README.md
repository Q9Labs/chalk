# Recorder fleet issuer

This command is the direct TLS identity issuer for capture and render nodes in
one Chalk environment. Do not put it behind a reverse proxy or load balancer:
node bootstrap authorization uses the TCP peer address and ignores forwarded
headers.

## Required configuration

- `CHALK_RECORDER_FLEET_ISSUER_LISTEN_ADDR` (defaults to `:8444`)
- `CHALK_RECORDER_FLEET_ISSUER_SERVER_CERT`
- `CHALK_RECORDER_FLEET_ISSUER_SERVER_KEY`
- `CHALK_RECORDER_FLEET_ISSUER_CONTROLLER_CA`
- `CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_CERT`
- `CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_KEY`
- `CHALK_RECORDER_FLEET_ISSUER_STATE_PATH`
- `CHALK_RECORDER_FLEET_ISSUER_PUBLIC_URL`
- `CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_URL`
- `CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_SERVER_NAME`
- `CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_SERVER_CA`
- `CHALK_RECORDER_FLEET_ISSUER_SPIFFE_TRUST_DOMAIN`
- `CHALK_RECORDER_FLEET_ISSUER_ENVIRONMENT`
- `CHALK_RECORDER_FLEET_ISSUER_OWNER_TAG`
- `CHALK_RECORDER_FLEET_ISSUER_DIGITALOCEAN_TOKEN_FILE`

`CHALK_RECORDER_FLEET_ISSUER_RENDER_GPU` defaults to false. Optional duration
settings are `CHALK_RECORDER_FLEET_ISSUER_CHALLENGE_TTL` (2 minutes),
`CHALK_RECORDER_FLEET_ISSUER_CERTIFICATE_LIFETIME` (12 hours), and
`CHALK_RECORDER_FLEET_ISSUER_RENEWAL_LEAD` (8 hours). The token and private-key
files must be readable only by the issuer service identity.

The server uses TLS 1.3. Controller registration and revocation require a
verified `recorder-fleet-controller` SPIFFE client identity. Renewal requires a
verified active capture or render identity. Initial node challenge and
bootstrap use server-authenticated TLS without a client certificate because
the node does not have one yet.

## Operations

- `GET /healthz` reports process liveness.
- `GET /readyz` reports loaded durable-state readiness.
- `GET /metrics` exports bounded operation/outcome counters.
- `GET /v1/recorder-fleet/crl.pem` returns the current worker CRL.

Monitor readiness from outside the process and alert on failures. The state
file must live on persistent storage and remain intact across restarts.
