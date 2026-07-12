defmodule ChalkSync.Operations.ProbeTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Probe

  setup do
    previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    previous_verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    previous_requirement = Application.fetch_env!(:chalk_sync, :require_production_auth)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
      Application.put_env(:chalk_sync, :token_verifier, previous_verifier)
      Application.put_env(:chalk_sync, :require_production_auth, previous_requirement)
    end)

    :ok
  end

  test "refuses the in-memory authority before any dependency probe" do
    Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Memory)
    Application.put_env(:chalk_sync, :require_production_auth, false)

    assert Probe.run(boot?: true) == {:error, :non_production_stateholder}
  end

  test "refuses the development verifier in production mode" do
    Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
    Application.put_env(:chalk_sync, :token_verifier, ChalkSync.Auth.DevTokenVerifier)
    Application.put_env(:chalk_sync, :require_production_auth, true)

    assert Probe.run(boot?: true) == {:error, :development_token_verifier}
  end

  test "requires the declared PostgreSQL durability settings" do
    required_migration = Application.fetch_env!(:chalk_sync, :required_sync_migration)

    observations = %{
      writable_primary: true,
      migration_version: required_migration,
      server_version_num: 180_000,
      fsync: "on",
      full_page_writes: "on",
      data_checksums: "on",
      synchronous_commit: "on",
      synchronous_standby_names_configured: false,
      synchronous_standbys: 0,
      wal_lag_bytes: 0,
      oldest_pending_lifecycle_intent_ms: 0
    }

    assert Probe.validate_database(observations) == :ok
    assert Probe.validate_database(%{observations | synchronous_commit: "remote_apply"}) == :ok

    assert Probe.validate_database(%{
             observations
             | migration_version: required_migration - 100_000
           }) ==
             {:error, :incompatible_database_migration}

    assert Probe.validate_database(%{observations | synchronous_commit: "remote_write"}) ==
             {:error, :synchronous_commit_disabled}

    assert Probe.validate_database(%{observations | server_version_num: 170_000}) ==
             {:error, :unsupported_postgres_version}

    for setting <- [:fsync, :full_page_writes, :data_checksums] do
      assert Probe.validate_database(Map.put(observations, setting, "off")) ==
               {:error, :unsafe_database_durability}
    end
  end
end
