defmodule ChalkSync.Operations.ProbeTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Probe

  setup do
    previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    previous_verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    previous_requirement = Application.fetch_env!(:chalk_sync, :require_production_auth)

    previous_standby_requirement =
      Application.fetch_env!(:chalk_sync, :require_synchronous_standby)

    previous_local_parity = Application.get_env(:chalk_sync, :local_parity)
    previous_provider_bridge = Application.get_env(:chalk_sync, :provider_bridge)

    previous_poll_interval =
      Application.fetch_env!(:chalk_sync, :external_operation_poll_interval_ms)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
      Application.put_env(:chalk_sync, :token_verifier, previous_verifier)
      Application.put_env(:chalk_sync, :require_production_auth, previous_requirement)

      Application.put_env(
        :chalk_sync,
        :require_synchronous_standby,
        previous_standby_requirement
      )

      restore_env(:local_parity, previous_local_parity)

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

  test "refuses production readiness without the private provider bridge" do
    Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
    Application.put_env(:chalk_sync, :token_verifier, ChalkSync.Auth.JWTTokenVerifier)
    Application.put_env(:chalk_sync, :require_production_auth, true)
    Application.delete_env(:chalk_sync, :provider_bridge)

    assert Probe.run(boot?: true) == {:error, :provider_bridge_not_configured}
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

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
