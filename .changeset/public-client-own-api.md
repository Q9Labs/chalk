---
"@q9labsai/chalk-client": patch
---

`createChalkPublicClient` is built from a generated API that holds only the unauthenticated `/v1/public` operations, so a page that only joins a call bundles about 12 KiB (gzip) less. Behavior and the exported API are unchanged.
