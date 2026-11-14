defmodule ChalkSync.WhiteboardV1.PostgresRepositoryAccessTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: FinalizerSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: PlannerSQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Poller
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.PostgresRepository
  alias ChalkSync.WhiteboardV1.PostgresRepository.Store
  alias ChalkSync.WhiteboardV1.SQL

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  test "a live board stays open through a removal or an end that is undone, and closes when final",
       %{connection: connection, host: host, participant: participant} do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 20)
    on_exit(fn -> Application.delete_env(:chalk_sync, :whiteboard_authority_poll_ms) end)
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)

    removed = [
      uuid(participant.episode.tenant_id),
      uuid(participant.episode.space_id),
      uuid(participant.episode.episode_id),
      uuid(participant.participant_id),
      participant.participant_generation,
      false,
      nil
    ]

    ended = Enum.take(removed, 3)
    socket = live_socket(participant, scene_id)

    # A host removes the Participant, the provider call fails, and the lifecycle restores them.
    # Each step waits for several reads, so the socket's answer reflects the database.
    lifecycle(connection, PlannerSQL.mark_participant_leaving(), removed)
    assert {:push, _frame, _state} = deliver(socket, scene_id)
    lifecycle(connection, FinalizerSQL.restore_participant_active(), removed)
    assert {:push, _frame, _state} = deliver(socket, scene_id)

    # The same for an Episode end that fails and is undone.
    lifecycle(connection, PlannerSQL.mark_episode_ending(), ended)
    assert {:push, _frame, _state} = deliver(socket, scene_id)
    lifecycle(connection, FinalizerSQL.restore_episode_active(), ended)
    assert {:push, _frame, _state} = deliver(socket, scene_id)

    # A removal that completes closes the socket for good, on its tick with no traffic.
    lifecycle(connection, PlannerSQL.mark_participant_leaving(), removed)
    lifecycle(connection, FinalizerSQL.complete_external_participant(), removed ++ [nil])

    assert {:stop, :normal, {1008, "policy violation"}, closed} =
             SocketWhiteboardV1.handle_info(:whiteboard_authority_tick, socket)

    # The read skips left rows, so the close trace names the Participant as no longer active.
    assert closed.terminal.denial == :participant_inactive

    assert {:push, _frame, _state} = deliver(live_socket(host, scene_id), scene_id)

    # An Episode end that completes closes every remaining socket.
    lifecycle(connection, PlannerSQL.mark_episode_ending(), ended)
    lifecycle(connection, FinalizerSQL.complete_external_episode(), ended)

    assert {:stop, :normal, {1008, "policy violation"}, closed} =
             deliver(live_socket(host, scene_id), scene_id)

    assert closed.terminal.denial == :episode_ended
  end

  test "reports the lifecycle state of every current Participant in an Episode", %{
    connection: connection,
    host: host,
    participant: participant
  } do
    assert {:ok, %{status: "active", participants: participants}} =
             PostgresRepository.episode_access(host.episode)

    assert participants[{String.downcase(host.participant_id), 1}] == "active"
    assert participants[{String.downcase(participant.participant_id), 1}] == "active"

    # Rows of Participants who left are history, so the read stays within the Episode's capacity.
    Postgrex.query!(
      connection,
      "update participants set status = 'left', left_at = now(), last_left_reason = 'left' where id = $1",
      [uuid(participant.participant_id)]
    )

    assert {:ok, %{participants: current}} = PostgresRepository.episode_access(host.episode)
    assert Map.keys(current) == [{String.downcase(host.participant_id), 1}]

    assert {:error, :not_found} =
             PostgresRepository.episode_access(%{host.episode | episode_id: UUID.generate()})
  end

  test "a board access read blocked by a lock gives up at the read deadline", %{host: host} do
    Application.put_env(:chalk_sync, :whiteboard_authority_read_ms, 300)
    on_exit(fn -> Application.delete_env(:chalk_sync, :whiteboard_authority_read_ms) end)
    {:ok, options} = Database.connection_options(@database_url)
    {:ok, locker} = Postgrex.start_link(options)
    test = self()

    holder =
      spawn(fn ->
        Postgrex.transaction(locker, fn pinned ->
          Postgrex.query!(pinned, "lock table episodes in access exclusive mode", [])
          send(test, :locked)
          receive do: (:release -> :ok)
        end)

        send(test, :released)
      end)

    assert_receive :locked, 5_000
    started_at = System.monotonic_time(:millisecond)

    assert Poller.read_access(host.episode) == {:retryable, {:storage_unavailable, "deadline"}}
    assert System.monotonic_time(:millisecond) - started_at <= 300 + 200

    send(holder, :release)
    assert_receive :released, 5_000
    assert {:ok, %{status: "active"}} = Poller.read_access(host.episode)
    GenServer.stop(locker)
  end

  test "names a bounded storage failure for close evidence" do
    assert Store.storage_failure(%DBConnection.ConnectionError{
             reason: :queue_timeout
           }) ==
             "queue_timeout"

    assert Store.storage_failure(%DBConnection.ConnectionError{}) == "connection"

    assert Store.storage_failure(%Postgrex.Error{postgres: %{code: :query_canceled}}) ==
             "timeout"

    assert Store.storage_failure(%Postgrex.Error{
             postgres: %{code: :undefined_table}
           }) == "postgres"
  end

  test "lists a snapshot in the byte order of the order keys and ids", %{connection: connection} do
    # A database collation such as en_US puts "aa" before "aA". The keys' own
    # order is byte order, and a client rewrites every key that arrives out of it.
    # The test database may already sort by bytes, so the query runs against a
    # copy of the table whose text columns sort the way a language does.
    scope = Enum.map(1..3, fn _index -> uuid(UUID.generate()) end)

    {:ok, {natural, listed}} =
      Postgrex.transaction(connection, fn pinned ->
        Postgrex.query!(
          pinned,
          """
          create temporary table sync_whiteboard_elements
            (like sync_whiteboard_elements including defaults) on commit drop
          """,
          []
        )

        Postgrex.query!(
          pinned,
          """
          alter table pg_temp.sync_whiteboard_elements
            alter column element_index type text collate "en-US-x-icu",
            alter column element_id type text collate "en-US-x-icu"
          """,
          []
        )

        Postgrex.query!(
          pinned,
          """
          insert into pg_temp.sync_whiteboard_elements (
            tenant_id, space_id, episode_id, scene_id, element_id, element_type,
            version, version_nonce, element_index, is_deleted, payload, encoded_bytes
          )
          select $1::uuid, $2::uuid, $2::uuid, $3::uuid, id, 'rectangle', 1, 1, index, false, '{}'::jsonb, 2
          from (values ('lower', 'aa'), ('upper', 'aA'), ('a', 'ab'), ('B', 'ab')) as elements(id, index)
          """,
          scope
        )

        natural =
          Postgrex.query!(
            pinned,
            "select element_index, element_id from pg_temp.sync_whiteboard_elements order by 1, 2",
            []
          ).rows

        {natural, Postgrex.query!(pinned, SQL.snapshot_elements(), scope).rows}
      end)

    assert natural == [["aa", "lower"], ["aA", "upper"], ["ab", "a"], ["ab", "B"]]

    assert Enum.map(listed, fn [id, _type, _version, _nonce, index | _rest] -> {index, id} end) ==
             [{"aA", "upper"}, {"aa", "lower"}, {"ab", "B"}, {"ab", "a"}]
  end

  defp live_socket(identity, scene_id) do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)
    Authority.watch(identity.episode)
    settle(identity.episode)

    %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity,
        display_name: "Ada",
        scene_id: scene_id,
        revision: 4
    }
  end

  # Another Participant's change reaching this socket through fanout.
  defp deliver(socket, scene_id) do
    SocketWhiteboardV1.handle_info(
      {:whiteboard_v1_frame,
       %{
         "type" => "update",
         "operation_id" =>
           "operation-#{String.pad_leading(Integer.to_string(System.unique_integer([:positive])), 10, "0")}",
         "scene_id" => scene_id,
         "revision" => "5",
         "elements" => [
           %{
             "id" => "element-1",
             "type" => "rectangle",
             "version" => 1,
             "version_nonce" => 1,
             "index" => "a0",
             "is_deleted" => false,
             "payload" => %{}
           }
         ]
       }},
      socket
    )
  end

  defp lifecycle(connection, statement, params) do
    assert {:ok, %Postgrex.Result{num_rows: 1}} =
             Postgrex.transaction(connection, fn transaction ->
               Transaction.configure(transaction)
               Postgrex.query!(transaction, statement, params)
             end)

    [tenant_id, space_id, episode_id | _participant] = params

    settle(%EpisodeKey{
      tenant_id: UUID.load!(tenant_id),
      space_id: UUID.load!(space_id),
      episode_id: UUID.load!(episode_id)
    })
  end

  # Waits for the Episode's poller to finish two reads that started after this point.
  defp settle(episode) do
    for _read <- 1..2 do
      [{_episode, _poller, _access, read_at, _failure}] = wait_for_entry(episode)
      wait_for_entry(episode, read_at)
    end
  end

  defp wait_for_entry(episode, after_ms \\ nil, attempts \\ 200) do
    case :ets.lookup(:whiteboard_authority_reads, EpisodeKey.authority_key(episode)) do
      [{_episode, _poller, _access, read_at, _failure}] = entry
      when is_nil(after_ms) or read_at > after_ms ->
        entry

      _missing_or_old when attempts > 0 ->
        Process.sleep(5)
        wait_for_entry(episode, after_ms, attempts - 1)
    end
  end

  # A socket whose connect check passed a second ago, before the reads the test waits for, so
  # those reads decide its access.
  defp connected_earlier, do: System.monotonic_time(:millisecond) - 1_000
end
