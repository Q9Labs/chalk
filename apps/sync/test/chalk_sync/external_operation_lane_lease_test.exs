defmodule ChalkSync.ExternalOperationLaneLeaseTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims

  test "every page of provider calls finishes inside the claim lease" do
    adapter_timeout_ms =
      Application.fetch_env!(:chalk_sync, :external_operation_adapter_timeout_ms)

    lease_ms = :timer.seconds(ExternalOperationClaims.lease_seconds())

    outliving =
      for {lane, spec} <- ExternalOperationConsumer.lane_specs(),
          spec.provider_calls,
          waves = div(spec.page_size + spec.concurrency - 1, spec.concurrency),
          waves * adapter_timeout_ms >= lease_ms,
          do: "#{lane}: #{waves} waves of #{adapter_timeout_ms} ms vs a #{lease_ms} ms lease"

    assert outliving == []
  end

  test "the claim query leases operations for the shared lease" do
    lease = "interval '#{ExternalOperationClaims.lease_seconds()} seconds'"

    for query <- [
          ExternalOperationClaims.claim_operations(),
          ExternalOperationClaims.claim_local_operations(),
          ExternalOperationClaims.claim_provider_operations()
        ] do
      assert query =~ lease
    end
  end
end
