This fixture is the unmodified Sync source, configuration, locked dependencies,
and test connection helpers from production commit
670d7c09e5b4f4fdc7f32c81a41c2cbd9f209cfd.

Reproduce the archive from the repository root:

    git archive 670d7c09e5b4f4fdc7f32c81a41c2cbd9f209cfd apps/sync/lib apps/sync/config apps/sync/mix.exs apps/sync/mix.lock apps/sync/test/support | gzip -n > source.tar.gz

SHA256: fb477506368eab4ba46af2aa9a9b411426ce8106e41c563dcf3dca043d32c455

The rolling tests compile this project separately with its own lockfile and run
its real Stateholder in another BEAM process against the same PostgreSQL. No
Stateholder module is replaced. Only the action driver lives outside the archive.
