2026-03-22 22:45 PKT
- investigated Cloudflare invoice + prod R2 bucket
- confirmed R2 cost spike was IA ops, not raw storage
- prod bucket ~100 GB; storage dollars tiny, IA class A/B dominated invoice
- patching terraform to remove 7-day IA transition; keeping 30-day retention delete

2026-03-22 16:10 PKT
- while shipping, repo gate exposed two unrelated blockers: mobile svg animated props typing and sdk-react-native formatting
- fixed both so lint/typecheck/test pass before push
- push exposed unrelated web CI failure from root postinstall referencing missing script in pruned workspace
- hardening root postinstall to skip when patch script is absent, then rerunning web CI
