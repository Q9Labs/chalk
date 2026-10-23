---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react": patch
---

Report Sync connection failures with the existing `connection.sync_hello_timeout` code without adding values to the public `ErrorCode` union. Add the current attempt's safe diagnostics to client errors, telemetry, and the call failure reference: opening/hello stage, close code and bounded reason, whether the socket opened, and elapsed time. Earlier attempts remain in the diagnostic history. Browsers do not expose DNS, TCP, or TLS progress. Unrecognized peer reasons are redacted. This is a compatible patch for the next client and React releases; released 5.1.0 files are unchanged.
