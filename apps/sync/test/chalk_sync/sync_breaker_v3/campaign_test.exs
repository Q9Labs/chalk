defmodule ChalkSync.SyncBreakerV3.CampaignTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.Campaign

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "runs every real seeded phase and reproduces the complete semantic artifact" do
    first = Campaign.run!(@database_url, 730_013)
    second = Campaign.run!(@database_url, 730_013)

    assert first["verdict"] == "pass"
    assert first["config"]["postgres_major"] == 18

    assert first["phase_order"] ==
             ~w(durable_lifecycle_reference external-operation-live-media delivery_recovery wire_sdk)

    assert Enum.all?(first["phases"], &(&1["verdict"] == "pass"))
    assert first["aggregate"]["bounds"]["schedule_steps"] == 37
    assert first == second
  end
end
