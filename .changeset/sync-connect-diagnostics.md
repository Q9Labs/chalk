---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react": patch
---

Preserve safe Sync connection failure diagnostics in client errors, telemetry, and the call failure reference: opening/hello phase, close code and bounded reason, whether the socket opened, and elapsed time. Browsers do not expose DNS, TCP, or TLS progress. Unrecognized peer reasons are redacted.
