# Tenant invitations

Only Owners (or Tenant API keys with `memberships:write`) can manage members and invitations. Acceptance and leaving require a signed-in Account, not an API key.

Invitations expire after seven days. Re-inviting an email revokes its old pending link. Acceptance matches the signed-in Account email case-insensitively, creates the membership and consumes the invitation in one transaction. Existing members keep their Role. A Tenant must keep at least one Owner, including during concurrent removals, departures and Role changes.

The issue response always contains `accept_link` and `email_delivered`. Resend delivery uses `CHALK_RESEND_API_KEY`, `CHALK_INVITATION_FROM` (a verified sender), and `CHALK_INVITATION_WEB_ORIGIN` (the dashboard origin). Without delivery configuration, or when delivery fails, `email_delivered` is false and the Owner can share the link. An absent origin produces a dashboard-relative link.

The UI lane must implement `/invitations/accept`, read `token` from the URL fragment, keep it through sign-in, and POST it to `/api/invitations/accept` through the account boundary. Tokens are never placed in query strings, stored in plaintext, or logged. Treat the issue response as a secret; do not send it to telemetry.

Expired, revoked and used links return HTTP 410 `invitation.unavailable`, instructing the Account to request a new invitation. Wrong-account acceptance returns HTTP 403 `invitation.wrong_account` without consuming the link. Last-Owner removal, leaving or demotion returns HTTP 409 `membership.last_owner`. Role denial returns HTTP 403 `access.forbidden`.

Onboarding requests retain their historical access ID after membership removal. Replaying an old request does not restore access or create a duplicate Tenant: it returns 404 while access is absent and the current membership after re-invitation. Role updates keep the existing decorated query telemetry; invitation and removal operations emit bounded success/failure spans and logs, with successful mutations recorded in the journey ledger without emails or tokens.
