# Recover Recording completion

A stopped Capture gets three automatic completion attempts. After an operator
fixes a transient completion fault, the operator can grant **one extra attempt**
while the source is retained. The grant does not restart Capture, reset counters
or change the automatic cap. It is not a public endpoint: the command uses
privileged database access.

Run it from `apps/api` with `CHALK_DATABASE_URL` and the `CHALK_R2_*` storage
settings in the environment (see `apps/api/cmd/recording-recover` for the flags):

```sh
go run ./cmd/recording-recover \
  --tenant-id "$TENANT_ID" \
  --recording-id "$RECORDING_ID" \
  --request-id "$RECOVERY_REQUEST_ID" \
  --operator "$OPERATOR_IDENTITY" \
  --reason 'Completion fault repaired'
```

Use a fresh UUID for the first request. To replay after an uncertain response,
keep the UUID, operator and reason unchanged: the replay succeeds without new
work. A different request for the same Recording is refused, even if the first
recovery failed. A failed or expired recovery stays terminal and gets no new
budget.

Recovery refuses an expired source, a missing object or a failed storage
inspection. Every bundle must still exist at its recorded size and checksum.
The source deadline is the stop-request time plus the Episode's Recording
retention, and recovery never renews it. Raise `--timeout` for a long Recording
over a slow link.

Success means the attempt is queued, not that completion worked. Follow the job
in the API logs and Sync spans in [observability](../observability.md). Every
grant is stored in the append-only `recording_completion_recoveries` table. A
runtime rollback must keep that migration.
