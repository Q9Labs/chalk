---
"@q9labsai/chalk-client": minor
---

Add `spaces.listSpaceActivity` (`GET /v1/tenants/{tenant_id}/space-activity`) and
its generated schemas and types. One read returns, for up to 300 Spaces, whether each
is archived, the live Episode with its full participant count and first five Participants, the latest
Episode with its status and start and end times, and up to five Participants who
most recently joined that Episode. It needs `episodes:read`; an unknown or other
Tenant's Space returns `404` for the whole batch. Existing operations are unchanged.
