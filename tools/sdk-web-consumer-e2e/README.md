# Packed web SDK consumer proof

This fixture packs `@q9labsai/chalk-client` and `@q9labsai/chalk-react`, installs
the tarballs in a temporary consumer outside the pnpm workspace, and bundles a
browser application using package imports only. It never imports from the Chalk
source tree.

The browser proof uses a localhost, protocol-faithful Sync and WebRTC signaling
mock. It proves SDK lifecycle and browser media behavior without claiming that
traffic reached Cloudflare. Chromium runs the complete two-context recovery
matrix. Firefox and WebKit run the launch smoke when their local Playwright
binaries are installed; CI installs and requires all three browsers.

Run the complete proof from the repository root:

```sh
pnpm --dir tools/sdk-web-consumer-e2e test
```

Use `--skip-build` only after both SDK packages have already been built.
