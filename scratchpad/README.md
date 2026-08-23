# Scratchpad

Public-safe project memory for Chalk: decisions, debugging lessons, deployment
patterns, and durable context.

Keep raw logs, customer-specific notes, tenant/account identifiers, signing
metadata, credentials, and private operational context out of this directory.

Default to summaries over verbatim logs. Preserve root causes, tradeoffs,
verification steps, and durable product decisions.

Weekly digests live in `history/`, and they are the durable memory. Fold a
week's session logs into its digest once the week is closed, then remove the
originals. `history/removed-documents.md` indexes the planning documents that
earlier sweeps removed and shows how to recover one from git history.

Long-form planning documents are working material, not a second archive. Once a
document's conclusions are in a digest, delete the document.
