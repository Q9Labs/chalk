# Observed connection reports

`observed-connection-reports.json` contains two accepted API SDK reports from
28 October 2026: W33 media recovery exhaustion (29 diagnostic events) and W34
failed media startup after slow initial capture (17 events). They were obtained
with a read-only Axiom query of the retained API logs, not reconstructed from
the incident prose or SDK code.

The service/event/trigger envelope fields and every diagnostic event are
unchanged. Tenant, Episode and participant identities are replaced with synthetic
values; the wall-clock timestamp is shifted to a fixed fixture time. No original
identities, trace IDs, provider payloads or credentials are retained. The report
is decoded into an object for readability; the replay serializes it back into
the exported `attributes.report` string before the monitor parses it.

Run `python3 test_monitors.py --live` from the parent directory with the private
Axiom query environment. The observation-derived regression verifies that the
previous monitor query emits no alert and the expanded query emits one affected
participant for each expected failure. Neither report includes the later cause
fields, so both must display `unknown`, not an invented diagnosis. The separate
synthetic test covers new cause fields and additional edge cases.
