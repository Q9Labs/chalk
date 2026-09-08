# Recorder fleet issuer boundary

The API server owns recorder fleet demand, durable node/generation bindings,
admission state, and revocation state. It does not mint worker certificates or
place bootstrap assertions on provider nodes. Those operations require a
separately deployed issuer that implements this adapter's protocol.

The API server connects to the issuer over TLS 1.3 mutual authentication using
an explicit client certificate, private key, server CA, and server name. The
five `CHALK_RECORDER_FLEET_ISSUER_*` settings are all-or-none. When they are
absent, `UnavailableAuthority` keeps bootstrap and revocation fail-closed.

## Protocol

`POST /v1/recorder-fleet/bootstrap` accepts JSON with:

- `schema_version: "recorder_fleet_issuer_bootstrap.v1"`
- the fields of `recorderfleet.BootstrapRequest`

After independently verifying the immutable provider node binding, the issuer
registers the exact worker identity and returns HTTP 202 while node delivery is
pending. The reconciler retries this idempotent request. Only after the node has
completed its direct bootstrap does the issuer return HTTP 200 with:

```json
{
  "schema_version": "recorder_fleet_issuer_bootstrap.v1",
  "identity": {
    "provider_id": "provider-node-id",
    "worker_id": "00000000-0000-4000-8000-000000000000",
    "role": "capture",
    "boot_generation": 1
  }
}
```

The certificate private key is generated and retained by the node. It and all
other reusable worker credentials are never returned to the API server.

`POST /v1/recorder-fleet/revoke` accepts JSON with:

- `schema_version: "recorder_fleet_issuer_revoke.v1"`
- `identity`, containing the exact `recorderfleet.NodeIdentity`

It returns HTTP 204 with an empty body only after that exact identity is
revoked. Calls must be idempotent. The API server records durable revocation
only after this response succeeds.

## Issuer implementation

`cmd/recorder-fleet-issuer` implements this boundary with durable file-backed
registration, challenge consumption, issuance, renewal, and revocation state.
It re-reads DigitalOcean inventory before registration and both node bootstrap
exchanges. Node authentication combines all of the following:

- an exact controller-authorized provider ID, release, image digest, boot
  generation, and canonical live inventory digest;
- a fresh DigitalOcean lookup with the expected immutable tags and firewall;
- the direct TCP peer address matching the droplet's sole live public IPv4;
- an Ed25519 CSR and a signature over a short-lived, single-use challenge.

DigitalOcean metadata supplies only a claimed provider ID. It is never treated
as proof. The issuer must be the direct TLS listener: a proxy, NAT, shared
egress address, or forwarded-address header invalidates the source-address
trust boundary.

The issuer returns the signed leaf and CA chain only to the node over its
server-authenticated TLS connection. It issues 12-hour leaves by default and
supports mTLS renewal eight hours before expiry. Revocation persists across
restarts and is published as an X.509 CRL. Credential consumers must enforce
the CRL; short certificate lifetime is not a substitute for revocation.
