---
"@q9labsai/chalk-client": patch
---

`Recording` now has `failure_code`, set when `status` is `failed`, such as `capture_empty` for a capture that recorded no media or `render_commit_failed` for a render that failed at its commit stage. It is `null` for every other status.
