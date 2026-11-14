---
"@q9labsai/chalk-client": patch
---

On the Chalk SFU, a receiver that learns of a new remote publication from a Sync media item pulls it right away instead of listing publications first. The listing still runs after the pull and stays the authority, so a missing or stale publication ID falls back to it. Cloudflare behavior is unchanged.
