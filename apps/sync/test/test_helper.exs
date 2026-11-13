# Every Sync suite runs against Postgres; a missing database fails the run instead of skipping.
ChalkSync.SyncPostgres.database_url!()

ExUnit.start(exclude: [:reliability_topology])
