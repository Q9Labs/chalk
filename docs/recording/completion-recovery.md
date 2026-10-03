# Recover Recording completion

A stopped Capture gets three automatic completion attempts. After a transient
completion fault is fixed, an operator can request **one additional completion
attempt** while the source is retained. This does not restart Capture, reset
attempt counters, or change the automatic completion cap.

Run the command from `apps/api` with operator-owned `CHALK_DATABASE_URL` and
`CHALK_R2_ACCOUNT_ID` (or `CHALK_R2_ENDPOINT`), `CHALK_R2_BUCKET`,
`CHALK_R2_ACCESS_KEY_ID`, and `CHALK_R2_SECRET_ACCESS_KEY` in the environment:

```sh
go run ./cmd/recording-recover \
  --tenant-id "$TENANT_ID" \
  --recording-id "$RECORDING_ID" \
  --request-id "$RECOVERY_REQUEST_ID" \
  --operator "$OPERATOR_IDENTITY" \
  --reason 'Completion fault repaired'
```

The command allows 15 minutes for source inspection by default. Set `--timeout`
to a longer positive duration when recovering a long Recording over a slow
connection; each storage request remains bounded to 15 seconds.

Use a fresh UUID for the first request. Keep that UUID, operator, and reason
unchanged when replaying an uncertain response. A replay returns success without
creating work; a different request for the same Recording is refused, even if
the recovery fails. The command uses privileged database access and is not a
public owner endpoint. Retry Export remains available after Capture completes.

Recovery requires a terminal Capture with three completion-only authorities,
an applied Capture stop, its retained encryption key, and nonempty bundle
metadata. Every bundle must still exist in object storage at its recorded size and checksum.
An expired source, missing object, or failed storage inspection refuses the
request. The source deadline is the original stop-request time plus the
Episode's immutable Recording retention; recovery never renews this deadline.
The worker's existing source validation still applies when completing Capture.

The request and its original attempt count, fencing generation, terminal error,
failure time, operator identity, database principal, reason, and source deadline
are stored in append-only `recording_completion_recoveries`. Existing attempt
authorities remain intact. The request, audit, and queue transition commit
atomically. A completion-capable Capture worker consumes the grant by advancing
the job's fencing generation, retaining the Capture epoch. The grant is never
reusable, and the recovery lease and its heartbeats cannot exceed source expiry.

A successful command means the attempt is queued, not that completion succeeded.
Inspect the Capture job and Recording through the existing diagnostics. A failed
or expired recovery stays terminal; it does not receive another retry budget.
Runtime rollback preserves the audit migration.
