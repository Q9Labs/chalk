---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react-native": patch
---

Client telemetry now leaves as wire version 2: every record has a `seq` and an `event_id`, every batch a `batch_id`, and one batch per source is in flight. A retry resends the same batch, and the outbox settles only the seqs the answer acknowledges. P0 records (call endings, failures, crashes, problem reports) are kept first when the queue is full, and what the client gives up is named in a `telemetry_dropped` record with its seq ranges. On the web a journal in `sessionStorage` keeps unsettled P0 records, the drop list and the high-water mark, and a reload of the tab sends them and reports the old source closed or abandoned. The API must accept version 2 before this SDK is released.
