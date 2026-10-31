defmodule ChalkSync.DepartureDelayAdapter do
  @moduledoc false

  def remove_participant({observer, delay}, operation_id, episode, _participant_id) do
    send(observer, {:cleanup_started, operation_id, episode.episode_id})
    Process.sleep(delay)
    send(observer, {:cleanup_finished, operation_id})
    :confirmed
  end
end

defmodule ChalkSync.ExternalOperationSchedulingPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
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

  test "claims rotate across Episodes and exclude claims already leased by another worker", %{
    connection: connection
  } do
    class = fixture(connection, 12)
    other = fixture(connection, 2)
    class_ids = for identity <- tl(class.identities), do: queue(identity, :participant_leave)
    other_id = queue(List.last(other.identities), :participant_leave)

    assert {:ok, first} = Postgres.claim_operations(8)
    first_ids = Enum.map(first, fn {_, operation} -> operation.external_operation_id end)
    assert other_id in first_ids
    assert Enum.count(first_ids, &(&1 in class_ids)) == 7

    assert {:ok, second} = Postgres.claim_operations(8)
    second_ids = Enum.map(second, fn {_, operation} -> operation.external_operation_id end)
    assert length(second_ids) == 4
    assert MapSet.disjoint?(MapSet.new(first_ids), MapSet.new(second_ids))
  end

  test "publication mutations and Episode end fence independent departures", %{
    connection: connection
  } do
    seed = fixture(connection, 3)
    [owner, first, second] = seed.identities
    mute_id = queue(owner, :mute_participant, %{"participantId" => first.participant_id})
    camera_id = queue(owner, :stop_participant_camera, %{"participantId" => first.participant_id})
    second_id = queue(second, :participant_leave)
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert {:ok, [{episode, mute}]} = Postgres.claim_operations(8)
    assert mute.external_operation_id == mute_id

    # Transaction timestamps can put a later accepted operation before an active
    # claim. It must still wait for that claim's provider mutation to finish.
    Postgrex.query!(
      connection,
      "update sync_external_operations set created_at = created_at - interval '1 hour' where external_operation_id = $1",
      [ChalkSync.UUID.dump!(camera_id)]
    )

    assert {:ok, []} = Postgres.claim_operations(8)
    confirm(episode, mute, adapter)

    assert {:ok, [{episode, camera}]} = Postgres.claim_operations(8)
    assert camera.external_operation_id == camera_id
    # Expired fences permit end reservation while an older publication change
    # and departure are still pending. Both must finish while status is ending.
    Postgrex.query!(
      connection,
      "update sync_publication_fences set created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' where episode_id = $1",
      [ChalkSync.UUID.dump!(episode.episode_id)]
    )

    end_id = queue(owner, :end_episode)
    assert {:ok, []} = Postgres.claim_operations(8)
    confirm(episode, camera, adapter)

    assert {:ok, [{episode, departure}]} = Postgres.claim_operations(8)
    assert departure.external_operation_id == second_id

    # An unfinalized predecessor remains a barrier even after it has been leased.
    assert {:ok, []} = Postgres.claim_operations(8)
    confirm(episode, departure, adapter)
    assert {:ok, [{episode, ending}]} = Postgres.claim_operations(8)
    assert ending.external_operation_id == end_id
    confirm(episode, ending, adapter)
  end

  @tag timeout: 120_000
  test "ten simultaneous wire Leaves and a later Episode have bounded durable acknowledgement", %{
    connection: connection,
    port: port
  } do
    delay = String.to_integer(System.get_env("CHALK_LEAVE_PROVIDER_DELAY_MS", "100"))
    class = fixture(connection, 10)
    other = fixture(connection, 1)
    observer = self()

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
       media_plane: {ChalkSync.DepartureDelayAdapter, {self(), delay}}}
    )

    class_tasks = Enum.take(tasks, 10)
    Enum.each(class_tasks, &send(&1.pid, :leave))
    # Start the second Episode after the first wave is already doing provider work.
    assert_receive {:cleanup_started, _, _}, 5_000
    send(List.last(tasks).pid, :leave)
    results = Task.await_many(tasks, 100_000)
    last_ack = results |> Enum.map(&elem(&1, 1)) |> Enum.max()
    other_ack = results |> List.last() |> elem(1)

    calls = drain_calls([])

    {peak, active} =
      Enum.reduce(calls, {1, 1}, fn
        {:cleanup_started, _, _}, {peak, active} -> {max(peak, active + 1), active + 1}
        {:cleanup_finished, _}, {peak, active} -> {peak, active - 1}
      end)

    IO.puts(
      "LEAVE_QUEUE delay_ms=#{delay} last_ack_ms=#{last_ack} other_ack_ms=#{other_ack} peak=#{peak}"
    )

    assert active == 0
    assert peak in 2..8
    assert last_ack < 3 * delay + 5_000
    assert other_ack < 2 * delay + 5_000
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

  defp queue(identity, name, payload \\ %{}) do
    {:ok, operation} = Operation.new("queue_" <> ChalkSync.UUID.generate(), name, payload)
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(identity, operation)
    assert is_binary(id)
    id
  end

  defp confirm(episode, operation, adapter) do
    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               operation,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )
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
      {:cleanup_finished, _} = call -> drain_calls([call | calls])
    after
      0 -> Enum.reverse(calls)
    end
  end
end
