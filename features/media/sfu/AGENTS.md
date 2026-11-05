# SFU

Chalk's own media forwarder, a second provider beside Cloudflare Realtime. Read `docs/sfu/design.md` and `docs/sfu/milestones.md` before changing behavior; the design owns the contract and the budgets.

- Never import `apps/api/internal`. The wire types live in the public `protocol/` package and follow the Cloudflare adapter's track and SDP shapes.
- Every operation is scoped to Tenant, Episode, Participant and generation. A session outside the caller's scope reads as gone, never as forbidden.
- Control is mutual TLS and the client certificate must name the expected service. Never log SDP, certificates or request bodies.
- One negotiation per session at a time. A failed negotiation step closes the session, because its peer connection cannot return to a stable state.
- Packet loops never hold a lock across network I/O. Bound everything: requests, tracks, sessions, subscriptions and pending offers.
- `tests/loopback_test.go` must keep using real HTTP and real Pion peers, not a fake media writer.
