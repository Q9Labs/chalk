defmodule ChalkSync.ProviderBridge.RecordingPlaneClientTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.RecordingPlane
  alias ChalkSync.Stateholder.EpisodeKey

  @operation_id "11111111-1111-4111-8111-111111111111"
  @recording_id "22222222-2222-4222-8222-222222222222"
  @tenant_id "33333333-3333-4333-8333-333333333333"
  @episode_id "44444444-4444-4444-8444-444444444444"
  @space_id "55555555-5555-4555-8555-555555555555"

  test "start sends the exact persisted reservation and stop omits it" do
    test_pid = self()

    transport = fn :post, _url, _headers, body, _options ->
      payload = JSON.decode!(body)
      send(test_pid, {:provider_request, payload})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => @operation_id,
         "effect" => payload["effect"],
         "outcome" => "confirmed"
       })}
    end

    adapter =
      Client.new!(base_url: "http://localhost:4101", transport: transport)
      |> RecordingPlane.new!()
      |> RecordingPlane.with_operation_payload(%{
        "recording_reservation" => %{
          "space_id" => @space_id,
          "participant_count" => 10,
          "max_duration_seconds" => 7200,
          "input_bitrate_bps" => 4_000_000,
          "policy_snapshot_version" => "episode_config.v2"
        }
      })

    episode = %EpisodeKey{tenant_id: @tenant_id, episode_id: @episode_id, space_id: @space_id}

    assert :confirmed =
             RecordingPlane.start_recording(adapter, @operation_id, episode, @recording_id)

    assert_receive {:provider_request, start_payload}

    assert start_payload["recording_reservation"] == %{
             "space_id" => @space_id,
             "participant_count" => 10,
             "max_duration_seconds" => 7200,
             "input_bitrate_bps" => 4_000_000,
             "policy_snapshot_version" => "episode_config.v2"
           }

    assert :confirmed =
             RecordingPlane.stop_recording(adapter, @operation_id, episode, @recording_id)

    assert_receive {:provider_request, stop_payload}
    refute Map.has_key?(stop_payload, "recording_reservation")
  end
end
