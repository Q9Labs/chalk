defmodule ChalkSync.Operations.ProbeTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Probe

  setup do
    previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    previous_verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    previous_requirement = Application.fetch_env!(:chalk_sync, :require_production_auth)
    previous_provider_bridge = Application.get_env(:chalk_sync, :provider_bridge)

    previous_poll_interval =
      Application.fetch_env!(:chalk_sync, :external_operation_poll_interval_ms)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
      Application.put_env(:chalk_sync, :token_verifier, previous_verifier)
      Application.put_env(:chalk_sync, :require_production_auth, previous_requirement)

      if previous_provider_bridge,
        do: Application.put_env(:chalk_sync, :provider_bridge, previous_provider_bridge),
        else: Application.delete_env(:chalk_sync, :provider_bridge)

      Application.put_env(
        :chalk_sync,
        :external_operation_poll_interval_ms,
        previous_poll_interval
      )
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

  test "refuses production readiness without the private provider bridge" do
    Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
    Application.put_env(:chalk_sync, :token_verifier, ChalkSync.Auth.JWTTokenVerifier)
    Application.put_env(:chalk_sync, :require_production_auth, true)
    Application.delete_env(:chalk_sync, :provider_bridge)

    assert Probe.run(boot?: true) == {:error, :provider_bridge_not_configured}
  end

  test "requires the declared PostgreSQL durability settings" do
    minimum_migration =
      Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration)

    observations = %{
      writable_primary: true,
      migration_version: minimum_migration,
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
             | migration_version: minimum_migration + 100_000
           }) == :ok

    assert Probe.validate_database(%{
             observations
             | migration_version: minimum_migration - 100_000
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

  test "rejects an unavailable, initializing, or stale external operation consumer" do
    assert Probe.validate_external_operation_health(%{consecutive_failures: 2}, false) ==
             {:error, :external_operation_consumer_unavailable}

    assert Probe.validate_external_operation_health(
             %{consecutive_failures: 0, last_success_at_ms: nil},
             false
           ) ==
             {:error, :external_operation_consumer_initializing}

    stale_at =
      System.monotonic_time(:millisecond) -
        Probe.external_operation_staleness_timeout_ms() - 1

    assert Probe.validate_external_operation_health(
             %{
               consecutive_failures: 0,
               last_success_at_ms: stale_at,
               active_work: false,
               active_work_age_ms: nil,
               active_work_timeout_ms: 165_000
             },
             false
           ) ==
             {:error, :external_operation_consumer_stale}

    assert Probe.validate_external_operation_health(
             %{consecutive_failures: 0, last_success_at_ms: stale_at},
             true
           ) == :ok
  end

  test "accepts only bounded active external operation work beyond the idle threshold" do
    stale_at =
      System.monotonic_time(:millisecond) -
        Probe.external_operation_staleness_timeout_ms() - 1

    health = %{
      consecutive_failures: 0,
      last_success_at_ms: stale_at,
      active_work: true,
      active_work_age_ms: 4_000,
      active_work_timeout_ms: 5_000
    }

    assert Probe.validate_external_operation_health(health, false) == :ok

    assert Probe.validate_external_operation_health(
             %{health | active_work_age_ms: 5_001},
             false
           ) == {:error, :external_operation_consumer_stale}

    assert Probe.validate_external_operation_health(
             %{health | consecutive_failures: 2},
             false
           ) == {:error, :external_operation_consumer_unavailable}
  end

  test "derives external operation staleness from the poll interval within bounds" do
    Application.put_env(:chalk_sync, :external_operation_poll_interval_ms, 100)
    assert Probe.external_operation_staleness_timeout_ms() == 2_000

    Application.put_env(:chalk_sync, :external_operation_poll_interval_ms, 10_000)
    assert Probe.external_operation_staleness_timeout_ms() == 30_000

    Application.put_env(:chalk_sync, :external_operation_poll_interval_ms, 5_000)
    assert Probe.external_operation_staleness_timeout_ms() == 15_000
  end
end
