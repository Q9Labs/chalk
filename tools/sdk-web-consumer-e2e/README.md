# Packed web SDK consumer proof

This fixture packs `@q9labsai/chalk-client`, `@q9labsai/chalk-react`, and their
supporting package archives, installs them in a temporary consumer outside the
pnpm workspace, and bundles a browser application using package imports only.
It never imports from the Chalk source tree. The fixture uses the root
`createSpaceClient` signature and public `/effect` seam solely to inject its
protocol-faithful local adapters, then passes the canonical `SpaceClient` to the
packed root `Chalk`; this exercises the public SpaceClient integration. The
access endpoint forwards an opaque `AccessGrant`; only the packed client
validates it.

The browser proof uses a localhost, protocol-faithful Sync and WebRTC signaling
mock. It proves SDK lifecycle and browser media behavior without claiming that
traffic reached Cloudflare. Chromium runs the complete two-context recovery
matrix. Firefox and WebKit run the launch smoke when their local Playwright
binaries are installed; CI installs and requires all three browsers.

Run the complete proof from the repository root:

```sh
pnpm --dir tools/sdk-web-consumer-e2e test
```

Use `--skip-build` only after the client, React, and their supporting packed
packages have already been built.
