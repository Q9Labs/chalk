# Unified Space public invites implementation session log

## 2026-08-19: isolated implementation started

Implementation runs in `/Users/macmini/code/chalk/.worktrees/unified-space-public-invites` on branch `codex/unified-space-public-invites`, based on clean commit `b456eb0828d53d26893ee26f589b4067bc004f34`. The original dirty `master` worktree remains untouched.

The accepted architecture is one `cspi1` Space invite and one Account-or-Guest public admission runtime for customer-managed and auto-created Spaces. The API owns public Space creation, invite management, Guest credentials, `open` and `knock` admission, renewal, leave, and auto-archive. The implementation must delete both legacy broker paths and their clients, configuration, monitoring, exemptions, and current documentation rather than keep a fallback or compatibility branch.

The first implementation wave separates API/domain work from legacy infrastructure removal. SDK and first-party client migration follows the generated API contract so generated files have one owner and the dependent clients do not invent a parallel contract.

## 2026-08-19: API contract and broker deletion established

The worktree now contains the `cspi1` domain, public-invite migration and SQLC queries, Postgres repository and auto-lifecycle state, public HTTP endpoint contracts, browser and native Guest credential transport, Tenant-authorized management and knock-decision routes, provider-neutral SFU/RealtimeKit subjects, and generated OpenAPI/TypeScript operations. Focused domain, HTTP, access-grant, Postgres adapter, codegen drift, dev orchestration, language-ratchet, deploy verifier, and smart-gate tests pass independently.

Both broker package trees are deleted. Workspace and lockfile importers, Durable Object/config files, broker dev process and bootstrap-key wiring, monitor/status references in owned infrastructure, fallow and ratchet exemptions, current README/product/glossary references, deploy checks, and gate fixtures are removed. Remaining legacy callers are isolated to the web, mobile, SDK, and API bootstrap surfaces assigned to the current migration lanes.

The composition audit found four runtime defects before production wiring: Account identity was trusted before Tenant-specific capability resolution; public Space creation did not grant creator access; knock approval marked an arrival admitted without creating its Participant/access; and arrival persistence lacked the media-provider subject needed for exact refresh and leave. Runtime and persistence lanes are correcting these while SDK, web, Dashboard, and native clients migrate against the stable generated contract.

## 2026-08-19: runtime identity, provider, and cleanup invariants closed

The public runtime now verifies a presented Account against the invite-resolved Tenant before it selects Account identity; unauthorized Accounts follow the Guest path. Open admission, idempotent replay, knock approval, refresh, and leave keep the exact Episode, Participant generation, provider, and provider subject. Access responses carry provider-specific client data for both Cloudflare SFU and RealtimeKit, while persistence stores only the provider binding and never stores a provider client token.

The auto-Space lifecycle has durable claim, retry, and archive state plus a scheduled worker that ends the live Episode and archives the Space through idempotent application ports. Persistence follow-up is adding creator-terminal cleanup and expired-claim recovery so a process crash cannot strand a Space in `archiving`. Space creation is gaining a post-commit invite materializer so both customer-managed and public-created Spaces converge on one generation-1 invite.

The TypeScript public client, Dashboard management UI, web arrival flow, React Native parser, and mobile arrival credential transport are in the worktree. Review found and returned three client regressions before handoff: Dashboard marker entry had lost its authenticated account path, copied links were not canonicalized after capability verification, and mobile diagnostics were deleted instead of migrated away from broker fields. Those lanes are correcting the behavior before generated-contract regeneration and integration tests.

## 2026-08-19: first-party clients and invite creation converge

Browser and mobile clients now use the same public-create, capability-first arrival, status, refresh, and leave contract. Dashboard account entry remains explicit, and an account join retrieves the server-issued canonical public URL before Chalk exposes the copy action. Browser RealtimeKit support uses the official Cloudflare SDK and preserves the SFU path. The mobile app keeps its diagnostics and lifecycle telemetry while removing broker configuration and ineffective legacy credential cleanup.

Space creation no longer relies on a post-commit observer. The Space insert and generation-1 public-invite insert now share one database statement, so a successful new Space cannot exist without its invite. Existing Spaces still use lazy, concurrency-safe invite materialization on the first authorized management read. The remaining integration work is executable composition, native RealtimeKit compatibility, final SQL/OpenAPI generation, and full flow verification.

## 2026-08-20: executable composition and first dogfood boot

The API executable now composes the dedicated cspi1 keyring, Postgres invite repository, Space, Account, access, and canonical-link ports, public HTTP routes, audit writer, and auto-Space lifecycle scheduler. Hosted environments fail closed without the public-invite keyring and managed-Tenant configuration. Local development derives a local-only keyring, creates or reuses a neutral managed Tenant, and uses the configured web CORS origin for canonical links.

The first front-door dogfood boot found three dev integration failures before the browser could load: route discovery assumed the route imported Chalk directly, a reused Postgres container could silently publish a different host port, and the local Space bootstrap omitted the now-required idempotency key. Each failure now has a focused regression test. The running API then exposed a fourth fault through its recurring lifecycle log: the stale-claim CTE was joined without a `RETURNING` clause. The query and generated SQLC output now return the reclaimed Tenant and Space IDs, and lifecycle failures include their safe error text so the operator can diagnose them.

## 2026-08-20: first browser failure traced to the dev proxy

The first browser pass reached the public Space form but its requests were sent to the default API port instead of this worktree's configured API. The web child environment now provides the exact API origin consumed by Vite, with a focused regression test. This same fix restores local account registration because the account boundary uses that origin too.

The failed create attempt also exposed a lost-response retry defect: the Space create operation was idempotent, but its creator arrival tried to mint a second Guest credential for the same request key. Public Space creation now requires the request key, recovers the existing arrival by that key, validates its invite and display-name binding, and refreshes the admitted access without returning or replacing the original Guest credential. The focused public-invite domain package passes with first-create and replay coverage.

The wire-level replay proof then found that the response recalculated the auto-archive deadline even though persistence returned the existing lifecycle. The runtime now returns the persisted deadline, so a repeated create response keeps the same link, arrival handle, and lifecycle timestamp. The browser rerun progressed past create after the dev proxy fix, but canonical URL replacement unmounted the page, sent `leave`, and archived the auto Space before the redirected route tried a second arrival. The web lane is carrying the admitted create result through canonicalization and suppressing cleanup only for that internal replacement.

The first handoff implementation still failed in the real development build because it destructively consumed module state inside a React state initializer. Strict Mode invoked that initializer twice, so the discarded render took the admitted handoff and the committed render showed the name form. The handoff is now read non-destructively during render and cleared only after the committed effect installs access. The real TanStack route-tree test now runs under Strict Mode and proves canonical index-to-slug replacement with one create, no second arrival, no replacement leave, admitted Chalk props, and normal cleanup on a genuine unmount.

Cold browser proof exposed one more scheduling detail: `replaceState` schedules the route transition, so the old index component remained active for one promise continuation and cleared the handoff before its unmount. Canonical create is now an explicit transfer. The index route publishes the admitted access and stops; the slug route alone consumes and installs it. A fresh browser run reaches owner prejoin directly with one create request, no second arrival, and no leave during canonical replacement.

## 2026-08-20: Dashboard controls and final gate findings

Dashboard dogfood created a persisted Space and exposed a missing web account-boundary mapping: the public-invite management GET returned 404 even though the API route existed. The boundary now maps invite reads, enablement, rotation, pending admission reads, approval, and denial with focused proxy tests. A second pass reached the canonical generation-1 link, but Disable returned 403. The browser boundary had validated Origin and CSRF, then omitted the trusted Origin on its server-to-API hop; the API's strict Origin guard rejected the mutation. The boundary now forwards only its validated same-origin value on mutations.

The remote API gate then found two composition defects. Bare local API startup had no Sync or media credential issuers, so always enabling the local public-invite runtime made lifecycle smoke fail before readiness. Local startup now leaves the public routes disabled until those existing credentials are configured, while hosted environments still fail closed. The new arrival model also called a Guest credential group a Session family, which violated Chalk's Episode vocabulary. The domain and database now call it a credential family, with regenerated SQLC output and a fresh-migration gate.

The first bounded review found five causal paths: native operations could bypass the resolved API origin, approved knock arrivals did not resume access, Guest retry credentials were not recoverable after a lost response, legacy Space mutations assumed an earlier invite GET, and unload cleanup dropped `keepalive`. These fixes are being applied at the mobile, browser/SDK, and public-invite domain seams before the final gate and re-review.

## 2026-08-20: final review and handoff gate

The final Terra xhigh review completed after the Mac restart and found four verified edge defects. Browser preflight now permits the arrival-handle header used by the public SDK. The mobile Space client passes the configured API base URL into every native transport. React Native accepts canonical HTTP invite links only on loopback hosts, while production hosts still require HTTPS. Knock admission creation now replays the existing request for the arrival instead of violating its one-request invariant after a lost response.

The affected API, mobile, and React Native tests and type checks pass. The canonical API gate is green, including migrations, SQLC, all Go tests, static checks, vulnerability analysis, and lifecycle smoke. The monorepo gate passed its hygiene, language, contract, and API phases, then reproduced the pre-existing shared Sync PostgreSQL pool failure: four unrelated lease/external-operation tests timed out after holding or waiting for the small shared connection pool. The same 406-test Sync correctness gate passed in isolation after the restart, so the failure is recorded as gate infrastructure contention rather than an invite regression.

Browser dogfood proves public creation transfers directly to prejoin with one create request and no replacement arrival or leave. Dashboard dogfood proves disable, re-enable, and rotation, and the current generation-3 link returns a successful public arrival and reaches prejoin after the local test Tenant uses the media provider available in the local stack. The pass did not enter media, and the retired generation-2 token was not retained for a fresh old-link rejection replay.

The implementation is committed on `codex/unified-space-public-invites` as `51d5d4ee` (`feat: unify public Space invites`). The commit was created without rerunning the hook after the hook reproduced the same unrelated Sync pool timeout; it was not pushed.
