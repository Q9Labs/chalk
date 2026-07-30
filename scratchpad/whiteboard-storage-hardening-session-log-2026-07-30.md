# Whiteboard Storage Hardening Session Log — 2026-07-30

- 2026-07-30 08:42 PKT — Audited the whiteboard file transfer path and found
  missing managed R2 CORS, incomplete runtime storage configuration, browser-
  forbidden presigned headers in upload instructions, and no real-browser
  transfer proof.
- 2026-07-30 09:03 PKT — Started implementation with ownership of shared
  object-storage/R2 behavior, whiteboard file enablement validation, recorder
  bucket CORS, and focused tests. Coordinated the shared storage boundary with
  the chat attachment lane.
- 2026-07-30 09:11 PKT — Added the local browser finding that whiteboard-v1
  subscriptions crash because the application does not supervise the default
  `:pg` process.
- 2026-07-30 09:24 PKT — Supervised the default `:pg` server and added a
  subscribe/broadcast/unsubscribe regression test; the focused Sync test passed
  with two tests and no failures.
- 2026-07-30 09:36 PKT — Added explicit whiteboard-file capability validation,
  a custom-endpoint local storage path, managed exact-origin R2 CORS, and
  production runtime validation that requires R2 whenever whiteboard files are
  enabled.
- 2026-07-30 10:24 PKT — Followed up on review feedback by enforcing the
  whiteboard-file capability at startup and at the router boundary while
  preserving shared-R2 chat attachments.
