# Colocated recording control runtime

The production target is three processes on the existing backend host: capture
fleet controller, render fleet controller, and identity issuer. API orchestration
remains inside the API. Postgres, Redis and private R2 retain their existing
roles. This does not introduce a controller server, database, queue or media
encoding workload on the backend.

## Release contract

The API component owns both API and recorder-control executable versions.
`images/recorder-control.Dockerfile` builds only the two existing Go control
executables for the selected host architecture. CI publishes the control image
as a separate immutable digest in the existing API repository and verifies its
managed signature. It is not an AMD64 media-worker image.

`images.recorder_control` in the release manifest is explicit enablement.
Manifests without it render no control units, request no recording secrets,
and do not publish the API worker port. The workflow's
`enable_recorder_control` input defaults to false. First enablement requires an
approved environment and rebuilds the API component. Once enabled, API releases
must supply a new control digest; Sync-only releases preserve the stable digest.
Worker image release IDs remain independent and must match the worker/API
presentation contract; the managed API version must not overwrite them.

## Identity, network and state

- The issuer uses host networking and direct TLS on 8444. Do not put an HTTP
  proxy, tunnel, or source-hiding rootless port forward in front of it: TCP peer
  identity is authorization evidence. Its public URL must reach that listener.
- The API publishes its separate mTLS worker listener on 8443 only in an enabled
  release. Public application routes remain on 8080; this is not a worker route
  on the public HTTP tunnel. Approve narrowly scoped ingress before enablement.
- Fleet controllers use host networking to reach the local API TLS listener;
  their configured server name must match its certificate. The API's issuer URL
  must be reachable from its rootless network with the configured TLS server name.
- The versioned SSM inventory adds three environment files and thirteen private
  secret files. Environment values are never sourced as shell. Mounted keys are
  readable only by container UID 65532. The worker CA signing key is mounted only
  in the issuer. Provider credentials are scoped by process and environment.
- Separate named Podman volumes hold capture/render journals and issuer state.
  The `state` subdirectory is private, and a nonblocking OS file lock gives each
  state file one process owner. Restart releases the lock, not the state. Do not
  delete volumes or run a second controller against separate copies of a journal.

Candidate limits are 128 MiB / 0.25 CPU for each fleet process and 256 MiB /
0.5 CPU for the issuer. These are bounds, not measured headroom guarantees.
No production build, benchmark, browser load or media encoding belongs here.

## Restore, rollback and verification

The existing deployment controller versions every enabled input, verifies the
runtime hashes, restores exact SSM versions on reboot, and restores stable units
and inputs after a failed release. Obsolete control processes are stopped before
their units are removed. Persistent volumes are retained across rollback.
The preparation migration cannot be reversed while it holds durable intents;
disable the feature and use forward-compatible application rollback instead.

Local checks:

```bash
bash infrastructure/managed-episode/scripts/test-recording-control
bash infrastructure/managed-episode/scripts/test-deployment-controller
bash scripts/recorder/qualify-capture-local.sh
```

The deployment tests use fakes. Runtime watchdog checks process liveness and
existing API/Sync readiness; this is not end-to-end recording evidence.
Before production approval, separately qualify direct TLS peer authorization,
certificate rejection, journal/issuer restart continuity, ordinary API/Sync
health under control load, worker/API/database clock alignment at capture
readiness, 0→10 readiness, a paced one-hour three-Participant
capture, and ten-way post-processing. Include camera/screen-share changes,
reconnects, slow/retried uploads, RSS/CPU/steal/backlog, and verified artifacts.
Retain the eight-hour recovery safety bound; the one-hour processing objective
is measured workload behavior, not a shortened recovery TTL.

The smaller capture candidates and direct DeepInfra adapter require their own
approved qualification. Production deployment/enablement, ingress changes,
secret issuance, new resources, paid provider traffic and qualification-host
deletion remain separate approval boundaries.
