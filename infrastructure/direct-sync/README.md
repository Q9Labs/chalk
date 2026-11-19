# Direct Sync infrastructure

`alchemy.run.ts` and `config.ts` own the Alchemy declaration and its typed inputs.
The [runtime proxy and retained OpenTofu root](../managed-episode/direct-sync/README.md)
remain at their existing paths. This stack has not been cut over. Use
`pnpm infra plan direct-sync nightly` only in the coordinated migration window.
