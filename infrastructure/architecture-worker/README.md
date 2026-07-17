# Protected architecture atlas Worker

This standalone Cloudflare Worker packages the repository-root architecture
atlas and every local dependency into one deployable script. The build rewrites
local HTML and CSS references to content-hashed `/assets/` routes, records their
SHA-256 digests, and rejects unresolved local references.

Every atlas page, manifest, and bundled asset requires an eight-hour HMAC-signed
session. The Worker stores only the SHA-256 verifier for the access code and the
session signing key as encrypted Cloudflare secrets. Login attempts use the
Cloudflare-native rate-limit binding (ten attempts per minute for each trusted
Cloudflare-provided client address). Rate-limit counters are
eventually consistent and local to a Cloudflare location, as documented by
Cloudflare; they are brute-force friction rather than an accounting boundary.

## Deploy and verify

From the repository root, run one command:

```sh
pnpm run architecture:deploy
```

The first run creates a strong access code in
`.private/architecture-worker-access-code` with mode `0600`. Set
`CHALK_ATLAS_ACCESS_CODE` to choose or rotate the code instead. Each deployment
rotates the session-signing secret, invalidating earlier sessions, and then
verifies the atlas before deploying the `architecture.access_boundary`
synthetic to the existing `chalk-uptime-worker`. The command verifies:

- anonymous HTML returns the access-code screen with `401`;
- anonymous content-hashed asset requests also return `401`;
- a valid code issues a `Secure`, `HttpOnly`, `SameSite=Strict` session;
- authenticated HTML matches the deployed build ID and contains no local file
  references;
- every authenticated asset's bytes, media type, and integrity header match the
  local build manifest.

The Cloudflare target is the new `chalk-architecture-atlas` Worker on its
`workers.dev` route. No custom production domain is configured. The command also
updates the existing `chalk-uptime-worker` with the private atlas URL while
retaining its remote variables and encrypted secrets.

For an explicitly approved atlas-only deployment, set
`CHALK_ATLAS_SKIP_MONITOR_DEPLOY=1`. This leaves the required recurring
synthetic inactive and is therefore not an operationally complete deployment.
