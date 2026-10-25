# Sync before presence expiry

`source.tar.gz` contains only the Sync runtime, config, Mix files and node-launch script from public commit `474999418aa4f336090c6735fc45edd1d9ac5306`.
The mixed-version wire regression boots this unchanged runtime so a later healthy entry does not renew the first runtime's lease.

Rebuild from the repository root with:

```sh
git archive --format=tar.gz --output=apps/sync/test/fixtures/pre-presence/source.tar.gz 474999418aa4f336090c6735fc45edd1d9ac5306 apps/sync/lib apps/sync/config apps/sync/mix.exs apps/sync/mix.lock apps/sync/scripts/sync-node-local.exs
```

SHA-256: `d7ba6b2df9c5193d0675f0c96b4612f2c5c1a6172e0fe6dd733491c8fd44bc36`.
