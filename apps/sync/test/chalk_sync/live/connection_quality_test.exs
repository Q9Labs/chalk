defmodule ChalkSync.Live.ConnectionQualityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.Projection
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.UUID

  setup do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    participant_id = UUID.generate()
    Memory.reset()

    :ok =
      Memory.seed_episode(episode, [
        %{id: participant_id, generation: 1, display_name: "Ada", role: "owner"}
      ])

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(outcomes: %{observe_episode_publications: {:ok, []}})

    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    identity = %Identity{
      episode: episode,
      participant_id: participant_id,
      participant_generation: 1
    }

    socket = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(socket, :kill) end)

    assert {:ok, live, _snapshots, _frames} =
             LiveEpisode.register(LiveEpisode.new(episode), identity, socket)

    {:ok, live: live, socket: socket, participant_id: participant_id}
  end

  test "a seat shows no quality until its socket reports one", %{live: live} do
    assert [item] = Projection.items(live.presence_projection)
    refute Map.has_key?(item, "connection_quality")
  end

  test "a reported tier reaches the presence stream and a repeat changes nothing",
       %{live: live, socket: socket, participant_id: participant_id} do
    assert {:ok, weak, [frame]} = LiveEpisode.set_connection_quality(live, socket, "weak")

    assert %{
             "stream" => "presence",
             "item" => %{
               "participant_id" => ^participant_id,
               "state" => "connected",
               "connection_quality" => "weak"
             }
           } = frame

    assert {:ok, ^weak, []} = LiveEpisode.set_connection_quality(weak, socket, "weak")

    assert {:ok, _poor, [%{"item" => %{"connection_quality" => "poor"}}]} =
             LiveEpisode.set_connection_quality(weak, socket, "poor")
  end

  test "a departed socket takes its tier with it", %{live: live, socket: socket} do
    assert {:ok, weak, _frames} = LiveEpisode.set_connection_quality(live, socket, "weak")
    gone = LiveEpisode.unregister(weak, socket)
    assert gone.connection_qualities == %{}
    assert {:ok, _reconciled, [%{"item" => item}]} = LiveEpisode.presence_snapshot(gone)
    assert item["state"] == "disconnected"
    refute Map.has_key?(item, "connection_quality")
  end

  test "an unknown socket and an unknown tier are refused", %{live: live, socket: socket} do
    assert {:error, :not_live} = LiveEpisode.set_connection_quality(live, self(), "weak")

    assert_raise FunctionClauseError, fn ->
      LiveEpisode.set_connection_quality(live, socket, "awful")
    end
  end
end
