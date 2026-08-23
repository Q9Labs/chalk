defmodule ChalkSync.ProviderBridge.ClientTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.EpisodeKey

  @tenant "00000000-0000-4000-8000-000000000001"
  @space "00000000-0000-4000-8000-000000000002"
  @episode_id "00000000-0000-4000-8000-000000000003"
  @episode %EpisodeKey{tenant_id: @tenant, space_id: @space, episode_id: @episode_id}
  @participant "00000000-0000-4000-8000-000000000004"

  test "media callbacks send exact private paths, bodies, and context headers" do
    transport = fn method, url, headers, body, options ->
      send(self(), {:request, method, url, headers, body, options})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "operation-0000001",
         "effect" => "media.grant_publication",
         "outcome" => "confirmed"
       })}
    end

    client =
      Client.new!(
        base_url: "http://localhost:4101/",
        transport: transport,
        context: %{
          journey_id: "journey-0001",
          traceparent: "00-4bf92f3577b34da6a3ce929c0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value"
        }
      )

    adapter = MediaPlane.new!(client)

    assert :confirmed =
             MediaPlane.grant_publication(
               adapter,
               "operation-0000001",
               @episode,
               @participant,
               :camera
             )

    assert_receive {:request, :post, url, headers, body,
                    [connect_timeout: 2_000, timeout: 5_000, ssl: []]}

    assert url == "http://localhost:4101/internal/v1/sync/provider-operations/operation-0000001"

    assert %{
             "effect" => "media.grant_publication",
             "tenant_id" => @tenant,
             "episode_id" => @episode_id,
             "participant_id" => @participant,
             "publication_source" => "camera"
           } = JSON.decode!(body)

    assert {"x-chalk-journey-id", "journey-0001"} in headers
    assert {"traceparent", "00-4bf92f3577b34da6a3ce929c0e0e4736-00f067aa0ba902b7-01"} in headers
    assert {"tracestate", "vendor=value"} in headers

    refute Enum.any?(JSON.decode!(body), fn {key, _value} ->
             key == "participant_generation"
           end)
  end
end
