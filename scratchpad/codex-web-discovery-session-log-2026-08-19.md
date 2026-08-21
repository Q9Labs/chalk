# Chalk web discovery session log

## 2026-08-19: baseline and implementation direction

- Hasan owns the new `/docs` surface. This lane covers discovery and marketing-site infrastructure outside the docs implementation.
- The live browser renders the landing page, but the origin response contains an empty body and depends on JavaScript for all page content.
- The live site has no canonical URL, Open Graph or Twitter metadata, structured data, manifest link, docs link, or agent index.
- `/sitemap.xml` and `/llms.txt` return the SPA shell with `200 text/html`, which creates false discovery resources.
- The selected fix keeps the dashboard and Space routes as an SPA, prerenders only public pages, and sends unknown routes to a separate SPA shell.
- `/docs` is included in the generated sitemap and minimal agent index, but its content and rendering remain owned by Hasan's docs lane.

## 2026-08-19: independent discovery slice complete

- Added route-level canonical, robots, Open Graph, Twitter, and 1200×630 social preview metadata for the landing, status, privacy, and terms pages.
- Added WebSite, Organization, and SoftwareApplication JSON-LD to the landing page.
- Added static `robots.txt`, `sitemap.xml`, and `llms.txt` discovery resources. The agent index names `/docs` as canonical and stays intentionally small.
- Added a Docs link to the landing navigation and developer footer without changing the page layout.
- Split the public page from the SPA fallback in redirects and service-worker caching so a prerendered landing page will not become the dashboard shell.
- Focused discovery, metadata, landing navigation, and build-script tests pass: 10 tests across five files.
- The shared docs work repeatedly replaced `vite.config.ts`, so the mixed prerender config is deferred until Hasan marks the docs lane ready.
- A clean remote build currently stops before prerender on an unrelated unresolved `@q9labsai/chalk-ui/assets` import from `sdks/typescript/react/src/internal/sound-cues.ts`.
