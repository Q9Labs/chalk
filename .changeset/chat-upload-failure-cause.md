---
"@q9labsai/chalk-client": patch
---

A failed chat file upload now keeps its cause on the error as `uploadFailure` (`initiate_failed`, `storage_unreachable` for a network or CORS block, `storage_rejected` with the storage HTTP status, or `finalize_failed`) and reports it through the connection report as a `chat_upload_failed` event with the `upload_failed` trigger. The API must accept these before this SDK is released.
