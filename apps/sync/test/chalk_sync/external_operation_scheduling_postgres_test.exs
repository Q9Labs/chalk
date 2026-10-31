defmodule ChalkSync.DepartureDelayAdapter do
  @moduledoc false

  def remove_participant({observer, delays}, operation_id, episode, participant_id) do
    delay = Map.fetch!(delays, participant_id)
    send(observer, {:cleanup_started, operation_id, episode.episode_id})
    Process.sleep(delay)
    send(observer, {:cleanup_finished, operation_id, episode.episode_id})
    :confirmed
  end
end

defmodule ChalkSync.ExternalOperationSchedulingPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous =
        for key <- [:stateholder, :database_connections],
            do: {key, Application.get_env(:chalk_sync, key)}

      connections = SyncPostgres.start_connections(@database_url, 8)
      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        for {key, value} <- previous do
          if value,
            do: Application.put_env(:chalk_sync, key, value),
            else: Application.delete_env(:chalk_sync, key)
        end

        Enum.each(connections, &TestProcess.stop/1)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  @tag timeout: 120_000
  test "mixed departures stay serial within an Episode and do not serialize another Episode", %{
    connection: connection,
    port: port
  } do
    delay = String.to_integer(System.get_env("CHALK_LEAVE_PROVIDER_DELAY_MS", "100"))
    class = fixture(connection, 10)
    other = fixture(connection, 1)
    observer = self()
    fast_delay = max(div(delay, 51), 1)

    delays =
      class.identities
      |> Enum.with_index()
      |> Map.new(fn {identity, index} ->
        {identity.participant_id, if(index in [0, 5], do: delay, else: fast_delay)}
      end)
      |> Map.put(hd(other.identities).participant_id, fast_delay)

    tasks =
      for identity <- class.identities ++ other.identities do
        Task.async(fn ->
          client = connect(port, identity)
          send(observer, {:ready, self()})
          receive do: (:leave -> :ok)
          started = System.monotonic_time(:millisecond)
          command_id = "leave_" <> ChalkSync.UUID.generate()

          client =
            Client.send_json(client, %{
              "type" => "operation",
              "command_id" => command_id,
              "name" => "participant_leave",
              "payload" => %{}
            })

          await_left(client, identity.participant_id)
          {identity.episode.episode_id, System.monotonic_time(:millisecond) - started}
        end)
      end

    for task <- tasks do
      pid = task.pid
      assert_receive {:ready, ^pid}, 5_000
    end

    start_supervised!({ChalkSync.Fanout.PostgresNotifications, url: @database_url})

    start_supervised!(
      {ExternalOperationConsumer,
       poll_interval_ms: 5,
       page_size: 32,
       adapter_timeout_ms: 35_000,
       media_plane: {ChalkSync.DepartureDelayAdapter, {self(), delays}}}
    )

    class_tasks = Enum.take(tasks, 10)
    Enum.each(class_tasks, &send(&1.pid, :leave))
    # Start the second Episode after the first wave is already doing provider work.
    assert_receive {:cleanup_started, _, first_episode}, 5_000
    send(List.last(tasks).pid, :leave)
    results = Task.await_many(tasks, 100_000)
    last_ack = results |> Enum.map(&elem(&1, 1)) |> Enum.max()
    other_ack = results |> List.last() |> elem(1)

    calls = drain_calls([])

    {peak, active, episode_peak, _} =
      Enum.reduce(calls, {1, 1, 1, %{first_episode => 1}}, fn
        {:cleanup_started, _, episode}, {peak, active, episode_peak, episodes} ->
          episodes = Map.update(episodes, episode, 1, &(&1 + 1))

          {max(peak, active + 1), active + 1, max(episode_peak, Map.fetch!(episodes, episode)),
           episodes}

        {:cleanup_finished, _, episode}, {peak, active, episode_peak, episodes} ->
          {peak, active - 1, episode_peak, Map.update!(episodes, episode, &(&1 - 1))}
      end)

    IO.puts(
      "LEAVE_QUEUE delay_ms=#{delay} last_ack_ms=#{last_ack} other_ack_ms=#{other_ack} peak=#{peak} episode_peak=#{episode_peak}"
    )

    assert active == 0
    assert peak in 2..8
    assert episode_peak == 1
    assert last_ack < 2 * delay + 8 * fast_delay + 5_000
    assert other_ack < delay + 2_000
    assert {:ok, []} = Postgres.claim_operations(8)
  end

  defp fixture(connection, count) do
    seed =
      SyncPostgres.seed_episode(connection, count, %{}, %{
        participants: List.duplicate(%{role: "owner"}, count)
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    seed
  end

  defp connect(port, identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "role" => identity.role,
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    {:ok, client} = Client.connect(port)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token,
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client
  end

  defp await_left(client, participant_id) do
    case Client.recv(client, 90_000) do
      {:json, %{"type" => "event"} = frame, client} ->
        client =
          Client.send_json(client, %{
            "type" => "delivery_ack",
            "stream" => "control",
            "revision" => frame["revision"],
            "state_digest" => frame["resulting_state_digest"]
          })

        if frame["name"] == "participant_left" and
             frame["payload"]["participant_id"] == participant_id,
           do: Client.close_tcp(client),
           else: await_left(client, participant_id)

      {:json, _frame, client} ->
        await_left(client, participant_id)

      other ->
        flunk("Leave did not receive durable participant_left: #{inspect(other)}")
    end
  end

  defp drain_calls(calls) do
    receive do
      {:cleanup_started, _, _} = call -> drain_calls([call | calls])
      {:cleanup_finished, _, _} = call -> drain_calls([call | calls])
    after
      0 -> Enum.reverse(calls)
    end
  end
end
