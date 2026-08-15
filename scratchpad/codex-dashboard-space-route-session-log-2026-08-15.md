# Dashboard Space route incident — 2026-08-15

## Diagnosis

- Production created the reported Episode and Participant in the anonymous broker Space. The intended Dashboard Space received no self-join request or durable Episode state.
- The deployed `/space` parent rendered the generic public `SpacePage` without a router `Outlet`. Because `/space/$slug` is its child, the named Dashboard route never mounted.
- The service worker returned the cached app shell for the route's HTTP 404, which hid the route mismatch and made the generic entrance appear usable.

## Repair

- Turn `/space` into a layout route with an `Outlet`.
- Move the generic public Space to the `/space/` index route.
- Add a real-router regression test proving a Dashboard URL selects the account-bound join path while `/space` keeps the public broker path.

Production identifiers and raw incident output remain under `.private/` and are not recorded here.
