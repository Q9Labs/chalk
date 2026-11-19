# R2 transcription lifecycle

`transcriptionLifecycle(id, props)` replaces the former OpenTofu module. Provide
the custom resource's API dependencies from the caller's Cloudflare layer:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Layer from "effect/Layer";
import { r2LifecycleProvider } from "./r2-transcription-lifecycle.ts";

const cloudflare = Cloudflare.providers();
const providers = Layer.merge(cloudflare, r2LifecycleProvider.pipe(Layer.provide(cloudflare)));
```

No root currently calls this module. The two
state buckets contain no instance of the former module, and a read-only scan
of all 20 buckets in the configured account found neither of its transcription
rules or temporary prefixes. The recorder's separate bucket lifecycle resource
is not this module and remains untouched.

The custom resource manages only the selected lifecycle rule IDs on an existing
bucket. It preserves unrelated rules on update and removal. It has no bucket
create/delete or object delete operation. This is stronger than retain-on-removal
on `Cloudflare.R2.Bucket`: the bucket never enters this resource's ownership, so
a removal-policy mistake cannot delete it or empty its objects. Lifecycle rules
themselves still expire the intended temporary objects after 24 hours.

Inputs retain the old module's contracts (now camelCase): `accountId` (32
lowercase hex characters), `bucketName` (valid R2 name), `temporaryPrefixes`
(nonempty relative prefixes, default `transcription/chunks/` and
`transcription/orphans/`), `temporaryExpirationHours` (exactly 24),
`committedCleanupDeadlineHours` (greater than zero, at most one, default one),
and `finalizedTranscriptPrefix` (default `transcription/finalized/`).

Rule IDs remain `expire-<trimmed-prefix-with-slashes-replaced-by-hyphens>`.
Rules delete temporary objects and abort multipart uploads after 86,400 seconds,
with no storage transitions. Validation rejects any prefix containing the
finalized transcript prefix, including during drift repair. Duplicate generated
rule IDs also fail. Committed-object deletion is still application-owned.
Outputs retain their snake_case names: `bucket_name`, `temporary_prefixes`,
`temporary_expiration_hours`, `committed_cleanup_deadline_hours`.

Before wiring a caller, inventory its existing bucket lifecycle configuration
privately, coordinate any other writers, and inspect a detailed plan. The R2
API replaces the whole configuration without compare-and-swap; unrelated rules
are preserved from the latest read, but concurrent writers must be excluded.
Restore the previous commit to roll back a rule update. Removing the resource
removes only its managed rule IDs, not unrelated rules, objects or the bucket.
Never use a destroy command as a migration rollback. No deployment was made as
part of this port.

```sh
pnpm --dir infrastructure check-types
pnpm --dir infrastructure test
```
