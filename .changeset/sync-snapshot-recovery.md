---
"@q9labsai/chalk-client": minor
---

Recover a call when Sync rejects a state update. Before, a client that rejected
an update (for example on a state digest mismatch) reconnected and rejected the
same update again without end. It now requests one fresh snapshot from Sync,
validates it before replacing local state, and resumes. Commands sent before or
during recovery complete once. If the snapshot is rejected too, the client stops
reconnecting and fails with the new public, non-recoverable code
`connection.state_digest_recovery_failed`. Integrators should handle it like
other terminal connection failures and offer a rejoin.
