# CI/CD Common Errors

> Descriptive snapshot, last verified against code on 2026-08-02. Not a source of truth.

- **HTTP 500 after deploy** – Cause: Startup crash due to missing environment or configuration. Fix: Check container logs for panic or fatal errors.
- **CORS errors** – Cause: Domain not allowed. Fix: Add the domain to the CORS middleware configuration.
- **SPA 404 on refresh** – Cause: Missing SPA fallback on Pages. Fix: Generate `index.html` and `404.html` from `_shell.html`.
- **Build ok, deploy fails** – Cause: Output path mismatch. Fix: Ensure the build output matches the deployment configuration.
- **Env vars undefined** – Cause: Build versus runtime environment variables. Fix: Variables prefixed with `VITE_*` are baked at build time; others are set at runtime.
