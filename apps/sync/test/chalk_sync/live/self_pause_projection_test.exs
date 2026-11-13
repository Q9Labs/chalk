defmodule ChalkSync.Live.SelfPauseProjectionTest do
  use ChalkSync.PostgresCase, async: false

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  test "a stopped screen does not reclaim the share lease after a new observation", %{
    connection: connection
  } do
    {episode, identity} = seed(connection)
    participant_id = identity.participant_id
    publication_id = "stopped-screen-track"
    :ok = Postgres.set_media_pause(identity, :screen, publication_id)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{
          observe_episode_publications:
            {:ok,
             [
               %{
                 participant_id: participant_id,
                 source: :screen,
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

    assert {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    assert [%{"source" => "screen", "enabled" => false}] = live.media_items
    assert live.screen_leases == %{}
    assert {:ok, reconciled, []} = LiveEpisode.reconcile(live)
    assert reconciled.screen_leases == %{}
  end

  test "self-disable preserves the legacy wire invariant without revoking the provider track", %{
    connection: connection
  } do
    {episode, identity} = seed(connection)
    participant_id = identity.participant_id
    publication_id = "cloudflare-camera-track"

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
               frame["item"]["publication_id"] == nil
           end)

    assert [%{"publication_id" => ^publication_id}] = paused.media_observed_items
    assert paused.media_pauses[{participant_id, "camera"}] == publication_id

    assert {:ok, persisted, []} = LiveEpisode.reconcile(paused)
    assert persisted.media_items == paused.media_items

    assert {:ok, rebuilt, rebuilt_frames} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    assert rebuilt.media_items == paused.media_items

    assert Enum.any?(rebuilt_frames, fn frame ->
             frame["stream"] == "media" and
               Enum.any?(frame["items"], fn item ->
                 item["enabled"] == false and item["publication_id"] == nil
               end)
           end)

    :ok = Postgres.set_media_pause(identity, :camera, nil)
    assert {:ok, resumed, _frames} = LiveEpisode.reconcile(persisted)
    assert [%{"enabled" => true, "publication_id" => ^publication_id}] = resumed.media_items

    refute Enum.any?(MediaPlaneTestAdapter.calls(adapter), fn {effect, _, _} ->
             effect == :revoke_publication
           end)
  end

  test "tab audio stays outside v1 projections and preserves the microphone on reconstruction", %{
    connection: connection
  } do
    {episode, identity} = seed(connection)
    participant_id = identity.participant_id

    publications =
      Enum.map([:microphone, :screen_audio], fn source ->
        %{
          participant_id: participant_id,
          source: source,
          enabled: true,
          publication_id: "shared-#{source}"
        }
      end)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_episode_publications: {:ok, publications}}
      )

    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    {:ok, live, _} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    assert Enum.all?(live.media_items, & &1["enabled"])
    refute Enum.any?(live.media_items, &(&1["source"] == "screen_audio"))

    assert Enum.find(live.media_items, &(&1["source"] == "microphone"))["enabled"]
    assert {:ok, persisted, []} = LiveEpisode.reconcile(live)
    assert persisted.media_items == live.media_items
    assert {:ok, rebuilt, _} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    assert rebuilt.media_items == live.media_items
  end

  defp seed(connection) do
    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {fixture.episode, hd(fixture.identities)}
  end
end
