# Meeting broker bootstrap

`bootstrap-meeting` is the narrow operator boundary for creating the first
production meeting-broker tenant. It connects only through
`CHALK_DATABASE_URL`, takes a transaction-scoped advisory lock, and commits the
tenant, owner membership, broker API key, and room together.

The owner user must already exist. The command creates or promotes that user's
membership to `owner`, configures the tenant for Chalk-managed `cf_sfu`, creates
an API key with only `sessions:write`, and creates one active `cf_sfu` room. It
reuses resources only when their names, provider settings, state, and scopes are
compatible; conflicting state fails without committing.

Run it from `apps/api`. Non-local environments require the explicit confirmation
flag:

```bash
result_directory="$(mktemp -d "${TMPDIR:-/tmp}/chalk-bootstrap.XXXXXX")"
CHALK_API_ENV=production \
CHALK_DATABASE_URL='<direct PostgreSQL URL with TLS verification>' \
go run ./cmd/bootstrap-meeting \
  --confirm-non-local \
  --owner-user-id '<existing user UUID>' \
  --result-file "${result_directory}/result.json"
```

`CHALK_API_ENV` has no implicit default: even local invocations must set it.
Outside `local`, the database URL must set `sslmode=require`, `verify-ca`, or
`verify-full`. Do not pass the database URL as an argument or enable shell
tracing. The command never prints the URL. Its only standard output is one JSON
object:

```json
{
  "tenant_id": "<tenant UUID>",
  "room_id": "<room UUID>",
  "api_key_id": "<API key UUID>",
  "api_key_created": true,
  "api_key_secret": "<one-time chalk_sk_ credential>"
}
```

The required `--result-file` must name a new file. The command creates it with
mode `0600`, durably writes the JSON before committing, and removes it when the
commit fails. Standard output repeats the same JSON after commit; if that stream
fails, the result file preserves the one-time credential. Check for a successful
exit before consuming the artifact.

`api_key_secret` is present only in the transaction that creates the key. A
successful repeated run returns the same IDs with `api_key_created: false` and
omits the secret, because stored API-key hashes cannot recover it. Capture the
first result directly into a secret manager; never copy it into a tracked file,
terminal log, or deployment manifest. Delete the result file after the values
are stored.

The default names can be changed with `--tenant-name`, `--room-name`,
`--room-slug`, and `--api-key-name`. `--api-key-ttl` accepts a Go duration and
cannot exceed 365 days. Changing an identity flag after the first run provisions
a distinct resource or fails on an incompatible collision, so keep the selected
values in the private deployment runbook. Identity flag whitespace is removed
before lookup and creation.

After capturing the first result, bind its values to the meeting broker as
`CHALK_API_KEY`, `CHALK_TENANT_ID`, and `CHALK_ROOM_ID`. The bootstrap command
does not deploy the API or Worker, apply migrations, or contact Cloudflare.
