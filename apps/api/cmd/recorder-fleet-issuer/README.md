# Recorder fleet issuer

The direct TLS identity issuer for capture and render nodes in one Chalk environment. Do not put it behind a reverse proxy or load balancer: node bootstrap authorization uses the TCP peer address and ignores forwarded headers. The trust model and protocol are in [the adapter README](../../internal/adapters/recorderfleetissuer/README.md).

`config.go` lists every `CHALK_RECORDER_FLEET_ISSUER_*` setting, default (listen address `:8444`, challenge TTL 2 minutes, certificate lifetime 12 hours, renewal lead 8 hours) and validation. The token and private-key files must be readable only by the issuer service identity, and the state file (`..._STATE_PATH`) must live on persistent storage and survive restarts intact.

Controller registration and revocation require a verified `recorder-fleet-controller` SPIFFE client identity. Renewal requires a verified active capture or render identity. Initial node challenge and bootstrap use server-authenticated TLS without a client certificate, because the node has none yet.

`GET /healthz` is liveness, `GET /readyz` is durable-state readiness, `GET /metrics` exports bounded counters, and `GET /v1/recorder-fleet/crl.pem` returns the worker CRL. Monitor readiness from outside the process and alert on failures.
