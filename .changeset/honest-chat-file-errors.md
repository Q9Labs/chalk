---
"@q9labsai/chalk-client": patch
---

Report chat attachment network and browser access failures without blaming storage.
Keep token acquisition failures separate with a diagnostic stage while preserving
the published error codes and original cause. Preserve recoverable access and
connection failures through SpaceClient, including signed storage uploads. Show
the storage-unavailable message only when a readable 503 response confirms
`chat.storage_unavailable`.
