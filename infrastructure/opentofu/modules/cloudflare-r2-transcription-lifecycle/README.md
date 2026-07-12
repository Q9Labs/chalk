# Cloudflare R2 transcription lifecycle module

This focused module manages lifecycle rules on an existing private R2 bucket
through the pinned Cloudflare provider. It creates no bucket, account, token,
or provider bootstrap resource, so adopting an existing production bucket stays
an explicit caller decision.

Only temporary transcription chunk and orphan prefixes are covered. They expire
after 24 hours, including abandoned multipart uploads. The application must
delete committed recording/transcript objects within one hour and verify that
deletion; lifecycle is an orphan safety net and is never authoritative for the
`transcription/finalized/` prefix. Plan-time checks reject a temporary prefix
that would contain that finalized prefix.
