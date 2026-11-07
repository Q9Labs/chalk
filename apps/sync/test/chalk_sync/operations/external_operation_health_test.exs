defmodule ChalkSync.Operations.ExternalOperationHealthTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Operations.Probe

  test "overdue active work is stale despite fresh discovery" do
    now = System.monotonic_time(:millisecond)

    assert Probe.validate_external_operation_health(
             health(now, true, 1_001, 1_000),
             false
           ) == {:error, :external_operation_consumer_stale}
  end

  test "overdue active work is stale with stale discovery" do
    assert Probe.validate_external_operation_health(
             health(stale_discovery_at(), true, 1_001, 1_000),
             false
           ) == {:error, :external_operation_consumer_stale}
  end

  test "in-budget active work keeps stale discovery healthy" do
    assert Probe.validate_external_operation_health(
             health(stale_discovery_at(), true, 1_000, 1_000),
             false
           ) == :ok
  end

  test "in-budget active work with fresh discovery is healthy" do
    now = System.monotonic_time(:millisecond)

    assert Probe.validate_external_operation_health(
             health(now, true, 1_000, 1_000),
             false
           ) == :ok
  end

  test "fresh discovery without active work is healthy" do
    now = System.monotonic_time(:millisecond)

    assert Probe.validate_external_operation_health(health(now), false) == :ok
  end

  test "stale discovery without active work is stale" do
    assert Probe.validate_external_operation_health(health(stale_discovery_at()), false) ==
             {:error, :external_operation_consumer_stale}
  end

  defp health(
         last_success_at_ms,
         active_work \\ false,
         active_work_age_ms \\ nil,
         active_work_timeout_ms \\ nil
       ) do
    %{
      consecutive_failures: 0,
      last_success_at_ms: last_success_at_ms,
      active_work: active_work,
      active_work_age_ms: active_work_age_ms,
      active_work_timeout_ms: active_work_timeout_ms
    }
  end

  defp stale_discovery_at do
    System.monotonic_time(:millisecond) - Probe.external_operation_staleness_timeout_ms() - 1
  end
end
