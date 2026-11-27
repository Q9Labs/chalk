# Document renderer

## Threat model

The renderer is designed to hold nothing worth stealing: it receives only a short-lived, per-job capability in the invocation event, while all object access is through pre-signed URLs and the Lambda execution role grants only CloudWatch Logs. A malicious document may still compromise the isolated child renderer process, so the child runs with a scrubbed environment, resource limits and a wall-clock kill, and any processing failure exits the parent so Lambda recycles the execution environment before another job. Linux process non-dumpability is applied as best-effort defense in depth rather than a trust boundary; denial is logged once and does not fail startup because the parent no longer possesses ambient workload or object-store authority.
