defmodule ChalkSync.Episodes.PublicationReconciliationTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.Reliability.TcpFaultProxy
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
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

  setup do
    previous = Application.get_env(:chalk_sync, :media_plane)
    previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
    Application.put_env(:chalk_sync, :stateholder, Memory)
    Application.put_env(:chalk_sync, :media_plane, {HeldMediaPlane, self()})

    on_exit(fn ->
      restore(:media_plane, previous)
      restore(:stateholder, previous_stateholder)
    end)

    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    :ok = Memory.seed_episode(episode)
    coordinator = start_supervised!({Coordinator, episode})

    identity = %Identity{
      episode: episode,
      participant_id: UUID.generate(),
      participant_generation: 1
    }

    {:ok, recovery} = Memory.recover_episode(episode, nil)
    {:ok, ^coordinator} = Coordinator.subscribe(identity, recovery.head)
    socket = self()

    :sys.replace_state(coordinator, fn state ->
      %{
        state
        | live: %{state.live | connections: %{socket => %{participant_id: UUID.generate()}}}
      }
    end)

    %{episode: episode, coordinator: coordinator}
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
    assert_receive {:sync_v1_live_frame, ^coordinator, _}, 1_000
    assert_receive {:sync_v1_live_frame, ^coordinator, _}, 1_000
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
    assert_receive {:sync_v1_live_frame, ^coordinator, _}, 1_000
    assert_converged(coordinator, 1)
  end

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  @tag skip: is_nil(@database_url)
  test "a dropped LISTEN connection reconnects and fresh publications still converge", %{
    episode: episode,
    coordinator: coordinator
  } do
    uri = URI.parse(@database_url)

    proxy =
      start_supervised!(
        {TcpFaultProxy,
         upstream_host: String.to_charlist(uri.host), upstream_port: uri.port || 5432}
      )

    proxy_url = URI.to_string(%{uri | port: TcpFaultProxy.port(proxy)})

    listener =
      start_supervised!({PostgresNotifications, url: proxy_url, name: {:global, make_ref()}})

    {:ok, options} = Database.connection_options(@database_url)
    connection = start_supervised!({Postgrex, options})
    notify(connection, episode)
    assert_receive {:observing, first, ^episode}, 1_000
    send(first, {:observation, observation(1)})
    assert_receive {:sync_v1_live_frame, ^coordinator, _}, 1_000
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
    assert_receive {:sync_v1_live_frame, ^coordinator, _}, 1_000
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

  defp observation(sequence) do
    {:ok,
     %{
       incarnation: 1,
       sequence: sequence,
       publications: [
         %{
           participant_id: "00000000-0000-4000-8000-000000000001",
           source: :microphone,
           enabled: true,
           publication_id: "fresh-#{sequence}"
         }
       ]
     }}
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
