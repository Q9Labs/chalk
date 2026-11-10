---
"@q9labsai/chalk-client": patch
---

Failure reports now include a `receivers_closed` event (how many receivers the client closed and whether one held the BUNDLE transport) and an `access_retry` event (the client asked for fresh access after a rejection). The API must accept these events before this SDK is released.
