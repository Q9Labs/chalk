defmodule ChalkSync.SyncBreakerV1.CampaignTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV1.Campaign

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "preserves phase verdicts, bounds, redaction, and deterministic replay" do
    first = Campaign.run!(@database_url, 730_013)
    second = Campaign.run!(@database_url, 730_013)

    assert first["verdict"] == "pass"
    assert first["config"]["postgres_major"] == 18

    assert first["phase_order"] ==
             ~w(durable_lifecycle_reference external-operation-live-media delivery_recovery wire_sdk)

    assert first["aggregate"]["phase_verdicts"] == %{
             "durable_lifecycle_reference" => "pass",
             "external-operation-live-media" => "pass",
             "delivery_recovery" => "pass",
             "wire_sdk" => "pass"
           }

    assert first["aggregate"]["bounds"] == %{"phases" => 4, "schedule_steps" => 36}
    assert first["aggregate"]["delivery_evidence"] != %{}
    assert first["aggregate"]["sdk_evidence"] != %{}

    refute inspect(first) =~ "#PID"

    for phase_name <- ["external-operation-live-media", "wire_sdk"] do
      phase = Enum.find(first["phases"], &(&1["name"] == phase_name))

      refute inspect(phase) =~
               ~r/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    end

    assert first == second
  end
end
