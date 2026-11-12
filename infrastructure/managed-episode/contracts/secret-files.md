# Runtime secret-file contract

The privileged boot workflow renders these source files outside the repository,
registers each one in the rootless `chalk` user's Podman secret store, and then
removes the transient registration input. The source files and environment
files must be regular files, owned by the runtime user or root, and mode `0600`.
Neither the release manifest nor journal output may contain their contents.
[`runtime-inputs.json`](runtime-inputs.json) is the canonical map from each
CI exclusion ID and SSM parameter suffix to these files. The deployment
controller fetches exact allowlisted names, streams each Podman secret over
standard input, verifies registration, and removes its private `/run` stage.

The migration input is separate from these application secrets. The mandatory
`managed-migrator-database-url` SSM `SecureString` is registered as
`chalk-managed-migrator-database-url`, mounted only by the one-shot migration
unit, and removed before API or Sync starts. It is never mounted in either
runtime service and has no exclusion path.

The source-file to Podman-secret to container-target map lives in `chalk-deployment-controller` and the Quadlet units. The `migration/database-url` secret mounts only in the migration unit.

The API server certificate must contain `chalk-api` in its DNS SAN. The Sync
client certificate identity must satisfy the API's SPIFFE trust-domain and
production-environment verifier. Certificate issuance and Podman secret
rotation remain external responsibilities. The controller registers and
reconciles the supplied values; it does not issue, rotate, or print production
credentials.
