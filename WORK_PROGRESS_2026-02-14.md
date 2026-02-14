# Work Progress 2026-02-14

- 13:25 PKT: Prod bug: `chalk.q9labs.ai/dashboard` sometimes 404 while `/` works; Pages deployment URL serves deep links correctly.
- 13:28 PKT: Web fix shipped: add SPA fallback via `_redirects`, and stop CI from deleting it during Pages deploy. Verified Pages deployment deep links work.
- 13:40 PKT: Root-cause narrowed: custom domain returns empty-body 404 for deep links while Pages `pages.dev` deployment returns SPA HTML for any path (rewrite working). Indicates custom-domain edge/rules not honoring SPA fallback.
- 13:45 PKT: Infra fix: add Cloudflare Transform Ruleset (prod) to rewrite HTML document navigations to `/` for host `chalk.q9labs.ai` (preserves browser URL; SPA router handles path).

