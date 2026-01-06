# Deployment Notes

Quick reference for deployment issues and fixes.

## Cloudflare Pages (Web Frontend)

### Pages Project Setup
- **Production domain**: `chalk.q9labs.ai` → attached to `chalk` project (NOT `chalk-web`)
- **Deploy command**: `wrangler pages deploy --project-name=chalk --branch=master`
- **Branch**: Must use `master` for production (project configured with master as prod branch)

### TanStack Start SPA Mode
- SSR requires Cloudflare Workers permission (our token only has Pages)
- Using SPA mode: `spa: { enabled: true }` in `tanstackStart()` plugin
- TanStack outputs `_shell.html` → must copy to `index.html` for Pages SPA fallback
- No `_redirects` needed - Pages auto-serves index.html for all routes when no 404.html exists

### Environment Variables
- `VITE_API_URL` must be set at build time (not runtime)
- Default fallback in code: `https://chalk-api.q9labs.ai`
- Pass `apiUrl` prop to `ChalkProvider`

## Go API (ECS)

### CORS Configuration
- File: `apps/api/internal/interfaces/http/middleware/cors.go`
- Must add production domains to `allowedOrigins` map
- Current allowed: localhost:3000/3070, chalk.q9labs.ai, chalk-5bc.pages.dev

### Test Quirks
- Config test expects port 8081 (not 8080) - matches actual default in config.go
