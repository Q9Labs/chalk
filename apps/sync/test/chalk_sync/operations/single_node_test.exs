defmodule ChalkSync.Operations.SingleNodeTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Probe

  setup do
    keys = [:require_synchronous_standby, :max_synchronous_wal_lag_bytes]
    previous = Enum.map(keys, &{&1, Application.fetch_env(:chalk_sync, &1)})

    on_exit(fn ->
      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:chalk_sync, key, value)
        {key, :error} -> Application.delete_env(:chalk_sync, key)
      end)
    end)

    Application.put_env(:chalk_sync, :require_synchronous_standby, false)
    Application.put_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)

    observations = %{
      writable_primary: true,
      migration_version: Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration),
      server_version_num: 180_000,
      fsync: "on",
      full_page_writes: "on",
      data_checksums: "on",
      synchronous_commit: "on",
      oldest_pending_lifecycle_intent_ms: 0,
      synchronous_standby_names_configured: false,
      synchronous_standbys: 0,
      wal_lag_bytes: 0
    }

    %{observations: observations}
  end

  test "approved single-node primary is ready without a standby", %{observations: observations} do
    assert :ok = Probe.validate_database(observations)
    assert "not_required" = Probe.synchronous_standby_requirement()
  end

  test "HA mode still rejects a missing standby", %{observations: observations} do
    Application.put_env(:chalk_sync, :require_synchronous_standby, true)

    assert {:error, :synchronous_standby_not_configured} = Probe.validate_database(observations)
  end

  test "single-node mode retains primary durability checks", %{observations: observations} do
    for setting <- [:fsync, :full_page_writes, :data_checksums] do
      assert {:error, :unsafe_database_durability} =
               Probe.validate_database(Map.put(observations, setting, "off"))
    end

    assert {:error, :synchronous_commit_disabled} =
             Probe.validate_database(%{observations | synchronous_commit: "off"})

    assert {:error, :database_not_writable_primary} =
             Probe.validate_database(%{observations | writable_primary: false})

    assert {:error, :unsupported_postgres_version} =
             Probe.validate_database(%{observations | server_version_num: 170_000})

    assert {:error, :incompatible_database_migration} =
             Probe.validate_database(%{observations | migration_version: 0})
  end
end
