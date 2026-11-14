---
"@q9labsai/chalk-client": patch
---

`episodes.end()` on an Episode that is already ending or ended now succeeds. The result has the Episode's `status` and no `external_operation`, so `external_operation` is optional in `EpisodeEnd`.
