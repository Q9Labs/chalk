defmodule ChalkSync.Episodes.PublicationReconciliationTest do
  use ChalkSync.PostgresCase, async: false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.Reliability.TcpFaultProxy
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  defmodule HeldMediaPlane do
    @moduledoc false
    def observe_episode_publications(owner, episode) do
      send(owner, {:observing, self(), episode})

      receive do
        {:observation, result} -> result
      end
    end
  end

  setup %{connection: connection} do
    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {HeldMediaPlane, self()})
    on_exit(fn -> restore(:media_plane, previous) end)

    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    episode = fixture.episode
    [identity] = fixture.identities

    coordinator = start_supervised!({Coordinator, episode})

    {:ok, recovery} = Postgres.recover_episode(episode, nil)
    {:ok, ^coordinator} = Coordinator.subscribe(identity, recovery.head)
    socket = self()

    :sys.replace_state(coordinator, fn state ->
      %{
        state
        | live: %{
            state.live
            | connections: %{
                socket => %{
                  participant_id: identity.participant_id,
                  generation: identity.participant_generation
                }
              }
          }
      }
    end)

    %{episode: episode, coordinator: coordinator, participant_id: identity.participant_id}
  end

  test "a storm during an in-flight reconciliation coalesces to one fresh read", %{
    episode: episode,
    coordinator: coordinator
  } do
    Coordinator.publication_observed(episode)
    assert_receive {:observing, first, ^episode}, 1_000
    for _ <- 1..100, do: Coordinator.publication_observed(episode)
    assert :sys.get_state(coordinator).live_reconcile_pending
    refute_receive {:observing, _, _}, 100
    send(first, {:observation, observation(1)})
    assert_receive {:observing, second, ^episode}, 1_000
    send(second, {:observation, observation(2)})
    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"}}, 1_000
    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"}}, 1_000
    assert_converged(coordinator, 2)
    refute_receive {:observing, _, _}, 200
  end

  test "hints for another tenant or Space do not start reconciliation", %{episode: episode} do
    reference = make_ref()

    state = %{
      notifications: self(),
      publication_ref: reference,
      received_count: 0,
      malformed_count: 0,
      last_received_at_ms: nil
    }

    for wrong <- [%{episode | tenant_id: UUID.generate()}, %{episode | space_id: UUID.generate()}] do
      payload = "#{wrong.tenant_id}:#{wrong.space_id}:#{wrong.episode_id}"

      PostgresNotifications.handle_info(
        {:notification, self(), reference, "chalk_media_publications", payload},
        state
      )

      refute_receive {:observing, _, _}, 100
    end

    Coordinator.publication_observed(episode)
    assert_receive {:observing, reader, ^episode}, 1_000
    send(reader, {:observation, observation(1)})
  end

  test "withdrawn publications tombstone before a replacement is projected", %{
    episode: episode,
    coordinator: coordinator,
    participant_id: participant_id
  } do
    reconcile_observation(episode, coordinator, 1, [publication(participant_id, "P")])
    assert_media_item(coordinator, participant_id, true, "P")

    frame = reconcile_observation(episode, coordinator, 2, [])
    assert_media_tombstone(frame, participant_id)
    state = :sys.get_state(coordinator).live
    assert state.media_items == []
    assert Map.values(state.media_projection.items) == [frame["item"]]

    reconcile_observation(episode, coordinator, 3, [publication(participant_id, "P2")])
    assert_media_item(coordinator, participant_id, true, "P2")
  end

  test "a pause for a withdrawn publication does not mask its replacement", %{
    episode: episode,
    coordinator: coordinator,
    participant_id: participant_id
  } do
    reconcile_observation(episode, coordinator, 1, [publication(participant_id, "P")])
    assert_media_item(coordinator, participant_id, true, "P")

    identity = %Identity{
      episode: episode,
      participant_id: participant_id,
      participant_generation: 1
    }

    assert :ok = Postgres.set_media_pause(identity, :microphone, "P")
    pause_key = {participant_id, "microphone"}

    :sys.replace_state(coordinator, fn state ->
      %{
        state
        | live: %{state.live | media_pauses: Map.put(state.live.media_pauses, pause_key, "P")}
      }
    end)

    assert :sys.get_state(coordinator).live.media_pauses[pause_key] == "P"

    frame = reconcile_observation(episode, coordinator, 2, [])
    assert_media_tombstone(frame, participant_id)
    state = :sys.get_state(coordinator).live
    assert state.media_items == []
    assert Map.values(state.media_projection.items) == [frame["item"]]
    refute Map.has_key?(state.media_pauses, pause_key)

    reconcile_observation(episode, coordinator, 3, [publication(participant_id, "P2")])
    assert_media_item(coordinator, participant_id, true, "P2")
  end

  @tag timeout: 20_000
  test "a missed publication notification converges via the real 15-second backstop", %{
    episode: episode,
    coordinator: coordinator
  } do
    started = System.monotonic_time(:millisecond)
    refute_receive {:observing, _, _}, 14_000
    assert_receive {:observing, reader, ^episode}, 3_000
    assert System.monotonic_time(:millisecond) - started >= 14_000
    send(reader, {:observation, observation(1)})
    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"}}, 1_000
    assert_converged(coordinator, 1)
  end

  test "a dropped LISTEN connection reconnects and fresh publications still converge", %{
    episode: episode,
    coordinator: coordinator
  } do
    uri = URI.parse(SyncPostgres.database_url!())

    proxy =
      start_supervised!(
        {TcpFaultProxy,
         upstream_host: String.to_charlist(uri.host), upstream_port: uri.port || 5432}
      )

    proxy_url = URI.to_string(%{uri | port: TcpFaultProxy.port(proxy)})

    listener =
      start_supervised!({PostgresNotifications, url: proxy_url, name: {:global, make_ref()}})

    {:ok, options} = Database.connection_options(SyncPostgres.database_url!())
    connection = start_supervised!({Postgrex, options})
    notify(connection, episode)
    assert_receive {:observing, first, ^episode}, 1_000
    send(first, {:observation, observation(1)})
    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"}}, 1_000
    assert_converged(coordinator, 1)
    notifications = :sys.get_state(listener).notifications
    accepted = TcpFaultProxy.stats(proxy).accepted
    :ok = TcpFaultProxy.partition(proxy)
    notify(connection, episode)
    refute_receive {:observing, _, _}, 200
    :ok = TcpFaultProxy.heal(proxy)
    second = await_observation(connection, episode, 80)
    assert TcpFaultProxy.stats(proxy).accepted > accepted
    assert :sys.get_state(listener).notifications == notifications
    send(second, {:observation, observation(2)})
    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"}}, 1_000
    assert_converged(coordinator, 2)
  end

  defp notify(connection, episode) do
    Postgrex.query!(connection, "select pg_notify('chalk_media_publications', $1)", [
      "#{episode.tenant_id}:#{episode.space_id}:#{episode.episode_id}"
    ])
  end

  defp await_observation(_connection, _episode, 0),
    do: flunk("LISTEN did not recover within eight seconds")

  defp await_observation(connection, episode, attempts) do
    notify(connection, episode)

    receive do
      {:observing, reader, ^episode} -> reader
    after
      100 -> await_observation(connection, episode, attempts - 1)
    end
  end

  defp observation(sequence, publications \\ nil) do
    {:ok,
     %{
       incarnation: 1,
       sequence: sequence,
       publications:
         publications ||
           [
             %{
               participant_id: "00000000-0000-4000-8000-000000000001",
               source: :microphone,
               enabled: true,
               publication_id: "fresh-#{sequence}"
             }
           ]
     }}
  end

  defp publication(participant_id, publication_id) do
    %{
      participant_id: participant_id,
      source: :microphone,
      enabled: true,
      publication_id: publication_id
    }
  end

  defp reconcile_observation(episode, coordinator, sequence, publications) do
    Coordinator.publication_observed(episode)
    assert_receive {:observing, reader, ^episode}, 1_000
    send(reader, {:observation, observation(sequence, publications)})

    assert_receive {:sync_v1_live_frame, ^coordinator, %{"stream" => "media"} = frame}, 1_000
    assert :sys.get_state(coordinator).live_reconcile_task == nil
    frame
  end

  defp assert_media_tombstone(frame, participant_id) do
    assert %{
             "type" => "projection_event",
             "item" => %{
               "participant_id" => ^participant_id,
               "source" => "microphone",
               "enabled" => false,
               "publication_id" => nil
             }
           } = frame
  end

  defp assert_media_item(coordinator, participant_id, enabled, publication_id) do
    assert [
             %{
               "participant_id" => ^participant_id,
               "source" => "microphone",
               "enabled" => ^enabled,
               "publication_id" => ^publication_id
             }
           ] = :sys.get_state(coordinator).live.media_items
  end

  defp assert_converged(coordinator, sequence) do
    state = :sys.get_state(coordinator)
    assert state.live.media_observation_cursor == {1, sequence}
    assert [%{"publication_id" => publication_id}] = state.live.media_items
    assert publication_id == "fresh-#{sequence}"
    assert state.live_reconcile_task == nil
  end

  defp restore(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore(key, value), do: Application.put_env(:chalk_sync, key, value)
end
