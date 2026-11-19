# Cloudflare TURN key

`alchemy.run.ts` declares `chalk-<stage>-turn` using
`@alchemy.run/cloudflare@2.0.0-beta.87`. Stage names retain the original
`^[a-z][a-z0-9-]{1,31}$` validation. Supply `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, or an Alchemy Cloudflare profile. The shell's
`_load_cloudflare_api_token` loads the existing 1Password-backed token used by
Wrangler. State uses the shared AWS credential chain and `AWS.state()` in
`ap-southeast-1`.

**Not deployed. Creating a key remains the owner's decision.** Neither state
bucket contains a TURN state root. The wrapper token can read DNS and R2, but
listing account TURN keys returns HTTP 403 / Cloudflare error 10000. Therefore
the existence of `chalk-nightly-turn` or `chalk-production-turn` is unproved;
do not infer absence from missing state. A credential with Calls/TURN read
access on the intended account is needed for inventory, and write access
would be needed for an approved creation.

Before creation, the provider lists keys and refuses an identically named key
not already owned by this stack. Cloudflare returns the bearer secret only at
creation; beta.87 has no cold adoption path. If a key exists, retain its current
secret and owner rather than create a duplicate. A key owned by this stack may
be updated normally.

Outputs remain `turn_key_id` and **redacted** `turn_api_token`; the latter is
never unwrapped for a log or checked into Git. Both become
`CHALK_CLOUDFLARE_TURN_KEY_ID` and `CHALK_CLOUDFLARE_TURN_API_TOKEN` in the private
API SSM configuration, never source. Treat the state store as secret material.
Retain-on-removal protects the key against accidental revocation; removing the
declaration does not revoke minted credentials. Restore the prior commit and
review a plan to undo a configuration change. To stop using TURN, remove both
API settings together. Revocation is a separate, explicit operation.

Credential-free checks (no creation):

```sh
pnpm --dir infrastructure check-types
pnpm --dir infrastructure test
```
