defmodule ChalkSync.Live.SelfPauseProjectionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.UUID

  test "self-disable changes the media projection without revoking the subscriber track" do
    episode = %EpisodeKey{
      tenant_id: "11111111-1111-4111-8111-111111111111",
      space_id: "22222222-2222-4222-8222-222222222222",
      episode_id: "33333333-3333-4333-8333-333333333333"
    }

    participant_id = "44444444-4444-4444-8444-444444444444"
    publication_id = "cloudflare-camera-track"
    Memory.reset()

    :ok =
      Memory.seed_episode(episode, [
        %{id: participant_id, generation: 1, display_name: "Participant", role: "owner"}
      ])

    identity = %Identity{
      episode: episode,
      participant_id: participant_id,
      participant_generation: 1
    }

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{
          observe_episode_publications:
            {:ok,
             [
               %{
                 participant_id: participant_id,
                 source: :camera,
                 enabled: true,
                 publication_id: publication_id
               }
             ]}
        }
      )

    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(episode))

    {live, result} =
      LiveEpisode.live_target(live, identity, %{
        name: :set_camera_enabled,
        operation_id: UUID.generate(),
        enabled: false
      })

    assert result["outcome"] == "confirmed"
    assert {:ok, paused, frames} = LiveEpisode.reconcile(live)

    assert Enum.any?(frames, fn frame ->
             frame["stream"] == "media" and frame["item"]["enabled"] == false and
               frame["item"]["publication_id"] == publication_id
           end)

    assert {:ok, persisted, []} = LiveEpisode.reconcile(paused)
    assert persisted.media_items == paused.media_items

    assert {:ok, rebuilt, _frames} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    assert rebuilt.media_items == paused.media_items

    refute Enum.any?(MediaPlaneTestAdapter.calls(adapter), fn {effect, _, _} ->
             effect == :revoke_publication
           end)
  end
end
