# Chalk delayed access-unavailable fix — 2026-08-02

## 2026-08-02 22:00 Asia/Karachi — diagnosis

The local Chalk browser backend reused one shared session forever. That session was created with a 3,600-second maximum duration; after its deadline, Chalk returned HTTP 409 from participant admission. The backend converted that upstream failure to HTTP 502, and the SDK surfaced it as `access_unavailable` because participant access was never obtained.

## 2026-08-02 22:07 Asia/Karachi — fix

The backend now treats one HTTP 409 admission failure as a stale shared session, creates one replacement session, and retries admission once. A rotation lock prevents concurrent browser joins from creating duplicate replacement sessions. New local demo sessions use the 86,400-second maximum duration.

## 2026-08-02 22:09 Asia/Karachi — verification

The focused web route tests passed: 10 tests. The real local browser join exercised the expired-session path, rotated from the stale session to a new 24-hour session, and reached `live` with 8 successful join spans.

## 2026-08-02 22:22 Asia/Karachi — review hardening

The rotation predicate now requires the API error code `session_not_active` in addition to HTTP 409, so capacity and idempotency conflicts remain visible instead of moving participants into a different session. Rotation emits structured attempt, skipped, success, and failure events with session IDs and safe error status/code fields. The focused web route tests passed: 12 tests, including non-stale conflict and failed-rotation telemetry cases.
