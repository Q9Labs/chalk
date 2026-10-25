# FIX — scoped Sol xhigh review, DO run never launched

Reviewed local staged operational harness against global code-review rules. Source intended and built: 1802a2fc5cb60d67556602f2dc14fa03b6b9e33f. The review ran from the dirty root checkout, not the detached build checkout, so it did not independently verify the binary artifact. Local extraction SHA256 was verified separately in source.json.

1. P1: run.py does not wire watchdog; fixed one-hour watchdog deadline is not budget-derived.
2. P1: stop_load SSH failure can skip cleanup; active-cut freeze can prevent paid-node deletion; exit status can remain successful after cleanup failure.
3. P1: provisioning timeout can occur before created-node discovery/persistence, orphaning a resource.
4. P1: SSM blocking flock permits a delayed mutation after local timeout/window void; no remote expiry or under-lock revalidation/cancellation.
5. P1: generator stop is checked only in sampling, not creation/readiness; stale stop markers can be cleared during subsequent launches.
6. P1: polled-only resource discovery can omit a short-lived failed-provisioning charge; reservations do not impose budget deadlines.
7. P2: bundle content-type/presence predicate alone is insufficient for declaring complete coverage; it accepts known holes and gap-only bundles.

The owner did not launch run.py or provision any DO node. These staged files are retained only as failure/review evidence, NOT approved runnable tooling. No SHIP verdict is claimed. No product or deployment change was shipped. A future run must harden and re-review the paid harness before use. User asked to report coverage holes, not require a zero-hole pass, so future completeness proof must distinguish missing committed bundles from legitimate gap metadata and report both.
