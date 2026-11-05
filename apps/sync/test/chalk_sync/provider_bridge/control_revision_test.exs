defmodule ChalkSync.ProviderBridge.ControlRevisionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.EpisodeKey

  @episode %EpisodeKey{
    tenant_id: "33333333-3333-4333-8333-333333333333",
    space_id: "55555555-5555-4555-8555-555555555555",
    episode_id: "44444444-4444-4444-8444-444444444444"
  }
  @participant "66666666-6666-4666-8666-666666666666"

  setup do
    owner = self()

    transport = fn :post, url, _headers, body, _options ->
      payload = JSON.decode!(body)
      id = url |> URI.parse() |> Map.fetch!(:path) |> Path.basename()
      send(owner, {:provider_call, payload})

      {:ok, 200, [],
       JSON.encode!(%{"operation_id" => id, "effect" => payload["effect"], "outcome" => "confirmed"})}
    end

    %{adapter: Client.new!(base_url: "http://localhost:4000", transport: transport) |> MediaPlane.new!()}
  end

  test "source grants, revokes and removals carry the deciding control revision", %{
    adapter: adapter
  } do
    adapter = MediaPlane.with_control_revision(adapter, 7)

    assert :confirmed =
             MediaPlane.grant_publication(adapter, "grant_revision_0001", @episode, @participant, :camera)

    assert_receive {:provider_call, %{"effect" => "media.grant_publication", "control_revision" => 7}}

    assert :confirmed =
             MediaPlane.revoke_publication(adapter, "revoke_revision_001", @episode, @participant, :screen)

    assert_receive {:provider_call, %{"effect" => "media.revoke_publication", "control_revision" => 7}}

    assert :confirmed =
             MediaPlane.remove_participant(adapter, "remove_revision_001", @episode, @participant)

    assert_receive {:provider_call, %{"effect" => "media.remove_participant", "control_revision" => 7}}

    assert :confirmed = MediaPlane.end_episode(adapter, "end_revision_000001", @episode)
    assert_receive {:provider_call, %{"effect" => "media.end_episode"} = ended}
    refute Map.has_key?(ended, "control_revision")
  end

  test "an operation recorded before revisions sends none", %{adapter: adapter} do
    adapter = MediaPlane.with_control_revision(adapter, nil)

    assert :confirmed =
             MediaPlane.revoke_publication(adapter, "revoke_unordered_01", @episode, @participant, :camera)

    assert_receive {:provider_call, %{"effect" => "media.revoke_publication"} = payload}
    refute Map.has_key?(payload, "control_revision")
  end
end
