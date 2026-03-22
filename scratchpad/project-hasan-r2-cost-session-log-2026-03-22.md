2026-03-22 22:45 PKT
- investigated Cloudflare invoice + prod R2 bucket
- confirmed R2 cost spike was IA ops, not raw storage
- prod bucket ~100 GB; storage dollars tiny, IA class A/B dominated invoice
- patching terraform to remove 7-day IA transition; keeping 30-day retention delete
