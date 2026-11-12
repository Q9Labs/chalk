# Recorder fleet issuer boundary

The API server owns recorder fleet demand, durable node/generation bindings, admission state and revocation state. It does not mint worker certificates or place bootstrap assertions on provider nodes; a separately deployed issuer does (`cmd/recorder-fleet-issuer`).

The API connects to the issuer over TLS 1.3 mutual authentication. The five `CHALK_RECORDER_FLEET_ISSUER_*` client settings (URL, client certificate and key, server CA, server name) are all-or-none. When absent, `UnavailableAuthority` keeps bootstrap and revocation fail-closed.

## Protocol invariants

The request and response shapes are in this package and carry `schema_version` values `recorder_fleet_issuer_bootstrap.v1` and `recorder_fleet_issuer_revoke.v1`.

- `POST /v1/recorder-fleet/bootstrap` is idempotent and the reconciler retries it. The issuer returns 202 while node delivery is pending and 200 with the worker identity only after the node completed its direct bootstrap. The certificate private key is generated and kept by the node, and no reusable worker credential ever returns to the API.
- `POST /v1/recorder-fleet/revoke` returns 204 only after that exact identity is revoked, and must be idempotent. The API records durable revocation only after this response succeeds.

## Why the issuer trusts a node

Node authentication needs all of: a controller-authorized provider ID, release, image digest, boot generation and canonical live inventory digest; a fresh DigitalOcean lookup with the expected immutable tags and firewall; a direct TCP peer address equal to the droplet's sole live public IPv4; and an Ed25519 CSR signed over a short-lived single-use challenge. DigitalOcean metadata supplies only a claimed provider ID, never proof. The issuer must therefore be the direct TLS listener: a proxy, NAT, shared egress address or forwarded-address header breaks the source-address trust boundary. Revocation persists across restarts and is published as an X.509 CRL, which credential consumers must enforce, because short certificate lifetimes do not replace revocation.
