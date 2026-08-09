# Retained event eligible_roles repair — 2026-08-09

- 2026-08-09 19:00 Asia/Karachi — Production migration `20260809160000` was fenced and failed atomically at the bridged payload preflight. Read-only evidence showed legacy `participant_joined` payloads retain `eligible_roles`.
- 2026-08-09 19:03 Asia/Karachi — Traced the v3 contract: `eligible_roles` is a unique 1–3 item role array, the event role must be included, and every role must exist in the immutable Episode policy after bridge role renaming.
- 2026-08-09 19:06 Asia/Karachi — Patched the unapplied migration to validate that legacy contract against `episodes.config_snapshot.roles`, remove only the top-level v3-only key, and recompute v1 reducer digests and encoded bytes from the translated payload.
- 2026-08-09 19:07 Asia/Karachi — Isolated PostgreSQL proofs passed for the exact legacy shape, unsupported payload fail-closed behavior, and mismatched selected-role `eligible_roles` fail-closed behavior; Goose remained `20260808150000` after rejected repairs.
