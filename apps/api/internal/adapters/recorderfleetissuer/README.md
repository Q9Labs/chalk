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
must idempotently mint or recover the exact worker identity, deliver its
one-time bootstrap assertion directly to that node, and return HTTP 200 with:

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

The assertion, certificate private key, and other credentials must never be
returned to the API server.

`POST /v1/recorder-fleet/revoke` accepts JSON with:

- `schema_version: "recorder_fleet_issuer_revoke.v1"`
- `identity`, containing the exact `recorderfleet.NodeIdentity`

It returns HTTP 204 with an empty body only after that exact identity is
revoked. Calls must be idempotent. The API server records durable revocation
only after this response succeeds.

## Deployment prerequisites

Enabling a fleet in production still requires all of the following outside
this repository:

- a deployed issuer implementing the protocol and direct one-time assertion
  delivery;
- a trusted worker certificate authority and revocation enforcement path;
- an immutable, digest-qualified worker image whose bootstrap binary consumes
  the one-time assertion and starts the selected worker role;
- provider-network and firewall qualification for the chosen region and image.

Until these prerequisites are supplied, the server authority routes exist but
new provider nodes cannot become active workers.
