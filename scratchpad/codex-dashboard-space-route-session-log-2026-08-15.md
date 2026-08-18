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

## Media access follow-up

- The repaired named route reached the account-bound join endpoint and created the intended Episode, but access issuance returned `media.unavailable` before any provider request.
- The affected Tenant had no media-plane provider configuration, and the Dashboard had created the Space on RealtimeKit even though the web Space client consumes Cloudflare SFU access grants.
- Production was repaired by enabling Chalk-managed media without pinning the Tenant to one provider and switching only the affected Space to Cloudflare SFU.
- Dashboard Space creation now has one SFU default in the API client; the dialog no longer overrides it.

## Episode Diagnostics follow-up

- The diagnostic resolver and snapshot endpoint were healthy, but the web app rejected the snapshot because the API emitted Participant values outside the public diagnostics contract.
- The API now maps stable anonymous labels and allowlisted Participant identity, state, and visibility values. Snapshot validation covers Participant projections so future server drift fails before a bad response ships.
- Cloudflare Pages deep links returned the SPA shell with HTTP 404 because the build emitted a top-level `404.html`. The build now relies on Pages' automatic SPA fallback, and deployment verification probes a dynamic Episode Diagnostics URL for HTML with HTTP 200.
