defmodule ChalkSync.WhiteboardV1.PostgresRepositoryTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: FinalizerSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: PlannerSQL
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.PostgresRepository
  alias ChalkSync.WhiteboardV1.SQL

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)

    on_exit(fn ->
      cleanup_whiteboard(connection, fixture.episode)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok,
     connection: connection,
     host: hd(fixture.identities),
     participant: List.last(fixture.identities)}
  end

  test "persists stable receipts, scene epochs, and drawing permissions", %{
    host: host,
    participant: participant
  } do
    assert {:ok,
            %{
              scene_id: scene_id,
              revision: 0,
              capabilities: ["drawWhiteboard", "manageWhiteboard"],
              participant_capabilities: ["drawWhiteboard", "manageWhiteboard"],
              can_draw: true,
              is_presenting: false
            }} =
             PostgresRepository.connect(host)

    assert {:ok,
            %{
              capabilities: [],
              participant_capabilities: [],
              can_draw: false
            }} = PostgresRepository.connect(participant)

    update = %{
      operation_id: "whiteboard-update-0001",
      scene_id: scene_id,
      elements: [element("shape-1", 1, 20)]
    }

    assert {:ok, %{outcome: :committed, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    assert {:ok,
            [
              %{
                operation_id: "whiteboard-update-0001",
                revision: 1,
                scene_id: ^scene_id
              }
            ]} = PostgresRepository.read_after(participant, scene_id, 0)

    assert {:ok, %{outcome: :duplicate, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    conflicting = %{update | elements: [element("shape-1", 2, 19)]}
    assert {:error, :operation_id_conflict} = PostgresRepository.commit_update(host, conflicting)

    assert {:ok, %{revision: 1, elements: [stored]}} = PostgresRepository.snapshot(participant)
    assert stored["id"] == "shape-1"
    assert stored["version"] == 1

    permission = %{
      operation_id: "whiteboard-permission-0001",
      participant_id: participant.participant_id,
      can_draw: false
    }

    assert {:ok, %{outcome: :committed, revision: 1}} =
             PostgresRepository.set_draw_permission(host, permission)

    denied_update = %{
      operation_id: "whiteboard-update-0002",
      scene_id: scene_id,
      elements: [element("shape-2", 1, 30)]
    }

    assert {:error, :permission_denied} =
             PostgresRepository.commit_update(participant, denied_update)

    presentation = %{operation_id: "whiteboard-presentation-0001", presenting: true}

    assert {:ok, %{outcome: :committed, scene_id: ^scene_id, revision: 2}} =
             PostgresRepository.set_presentation(host, presentation)

    assert {:ok, %{is_presenting: true}} = PostgresRepository.connect(participant)

    assert {:ok, %{outcome: :duplicate, revision: 2, presenting: true}} =
             PostgresRepository.set_presentation(host, presentation)

    second_update = %{denied_update | operation_id: "whiteboard-update-0003"}

    assert {:ok, %{outcome: :committed, revision: 3}} =
             PostgresRepository.commit_update(host, second_update)

    assert {:ok,
            [
              %{type: :presentation, revision: 2, presenting: true},
              %{type: :update, revision: 3}
            ]} = PostgresRepository.read_after(participant, scene_id, 1)

    clear = %{operation_id: "whiteboard-clear-0001", scene_id: scene_id}

    assert {:ok, %{outcome: :committed, scene_id: new_scene_id, revision: 0}} =
             PostgresRepository.clear(host, clear)

    assert new_scene_id != scene_id
    assert {:error, :stale_scene} = PostgresRepository.commit_update(host, denied_update)

    assert {:ok, %{scene_id: ^new_scene_id, revision: 0, elements: [], is_presenting: true}} =
             PostgresRepository.snapshot(host)
  end

  test "large periodic resends retain only scene changes and allow later strokes", %{
    connection: connection,
    host: host,
    participant: participant
  } do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)
    elements = Enum.map(1..200, &handwriting_element/1)
    assert byte_size(JSON.encode!(elements)) > 262_144

    elements
    |> Enum.chunk_every(20)
    |> Enum.with_index(1)
    |> Enum.each(fn {batch, index} ->
      assert {:ok, %{revision: ^index}} =
               PostgresRepository.commit_update(host, %{
                 operation_id: "handwriting-batch-#{index}",
                 scene_id: scene_id,
                 elements: batch
               })
    end)

    resend = %{operation_id: "handwriting-full-resend", scene_id: scene_id, elements: elements}

    assert {:ok, %{"revision" => "11"}, [empty_frame]} = Episode.submit_update(host, resend)
    assert empty_frame["elements"] == []
    assert GeneratedWhiteboardV1.valid_server_frame?(empty_frame)
    assert {:ok, [^empty_frame]} = Episode.read_after(participant, scene_id, 10)

    assert {:ok, [%{revision: 11, elements: []}]} =
             PostgresRepository.read_after(participant, scene_id, 10)

    assert [[2]] =
             Postgrex.query!(
               connection,
               """
               select event_encoded_bytes from sync_whiteboard_operation_receipts
               where participant_id = $1 and operation_id = $2
               """,
               [uuid(host.participant_id), resend.operation_id]
             ).rows

    assert {:ok, %{outcome: :duplicate, revision: 11}} =
             PostgresRepository.commit_update(host, resend)

    [first, second | rest] = elements
    edit = %{first | "version" => 2}
    deletion = %{second | "version" => 2, "is_deleted" => true}
    stroke = handwriting_element(201)

    mixed = %{
      resend
      | operation_id: "handwriting-mixed-update",
        elements: [edit, deletion | rest] ++ [stroke]
    }

    assert {:ok, %{revision: 12}} = PostgresRepository.commit_update(host, mixed)

    assert {:ok, [%{elements: [^edit, ^deletion, ^stroke]}]} =
             PostgresRepository.read_after(participant, scene_id, 11)

    losing = %{
      resend
      | operation_id: "handwriting-losing-update",
        elements: [first, %{edit | "version_nonce" => 100}]
    }

    assert {:ok, %{revision: 13}} = PostgresRepository.commit_update(host, losing)
    assert {:ok, [%{elements: []}]} = PostgresRepository.read_after(participant, scene_id, 12)
    assert {:ok, %{revision: 13, elements: stored}} = PostgresRepository.snapshot(participant)
    assert length(stored) == 201
    assert edit in stored
    assert deletion in stored
    assert stroke in stored
  end

  test "accepts genuinely changed multipart-sized handwriting events", %{
    connection: connection,
    host: host,
    participant: participant
  } do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)
    elements = Enum.map(1..200, &handwriting_element/1)
    bytes = byte_size(JSON.encode!(elements))
    assert bytes > 262_144
    assert bytes < 16_777_216

    update = %{operation_id: "handwriting-large-change", scene_id: scene_id, elements: elements}
    assert {:ok, %{revision: 1}} = PostgresRepository.commit_update(host, update)

    assert {:ok, [%{elements: ^elements}]} =
             PostgresRepository.read_after(participant, scene_id, 0)

    assert [[^bytes]] =
             Postgrex.query!(
               connection,
               """
               select event_encoded_bytes from sync_whiteboard_operation_receipts
               where participant_id = $1 and operation_id = $2
               """,
               [uuid(host.participant_id), update.operation_id]
             ).rows

    assert bytes * 3 > 2_097_152

    Enum.each(2..3, fn version ->
      changed = Enum.map(elements, &Map.put(&1, "version", version))

      assert {:ok, %{revision: ^version}} =
               PostgresRepository.commit_update(host, %{
                 update
                 | operation_id: "handwriting-large-change-#{version}",
                   elements: changed
               })
    end)

    assert {:error, :cursor_reset_required} =
             PostgresRepository.read_after(participant, scene_id, 0)

    assert {:ok, [%{revision: 3}]} = PostgresRepository.read_after(participant, scene_id, 2)
    assert {:ok, %{revision: 3, elements: stored}} = PostgresRepository.snapshot(participant)
    assert length(stored) == 200
    assert Enum.all?(stored, &(&1["version"] == 3))
  end

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
      participant.participant_generation
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
    lifecycle(connection, FinalizerSQL.complete_external_participant(), removed)

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

  test "names a bounded storage failure for close evidence" do
    assert PostgresRepository.storage_failure(%DBConnection.ConnectionError{
             reason: :queue_timeout
           }) ==
             "queue_timeout"

    assert PostgresRepository.storage_failure(%DBConnection.ConnectionError{}) == "connection"

    assert PostgresRepository.storage_failure(%Postgrex.Error{postgres: %{code: :query_canceled}}) ==
             "timeout"

    assert PostgresRepository.storage_failure(%Postgrex.Error{
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

  defp handwriting_element(index) do
    points = Enum.map(1..150, fn point -> [point / 3, :math.sin(point / 5) * 20] end)

    %{
      "id" => "handwriting-#{index}",
      "type" => "freedraw",
      "version" => 1,
      "version_nonce" => 20,
      "index" => "a#{index}",
      "is_deleted" => false,
      "payload" => %{"x" => index * 10, "y" => 20, "points" => points}
    }
  end

  defp live_socket(identity, scene_id) do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)
    Authority.watch(identity.episode)
    settle(identity.episode)

    %{
      initial
      | phase: :live,
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
    assert %Postgrex.Result{num_rows: 1} = Postgrex.query!(connection, statement, params)
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
    case :ets.lookup(Authority, EpisodeKey.authority_key(episode)) do
      [{_episode, _poller, _access, read_at, _failure}] = entry
      when is_nil(after_ms) or read_at > after_ms ->
        entry

      _missing_or_old when attempts > 0 ->
        Process.sleep(5)
        wait_for_entry(episode, after_ms, attempts - 1)
    end
  end

  defp element(id, version, version_nonce) do
    %{
      "id" => id,
      "type" => "rectangle",
      "version" => version,
      "version_nonce" => version_nonce,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 10, "y" => 20, "width" => 100, "height" => 60}
    }
  end

  defp cleanup_whiteboard(connection, episode) do
    params = [uuid(episode.tenant_id), uuid(episode.space_id)]

    Enum.each(
      [
        "sync_whiteboard_files",
        "sync_whiteboard_operation_receipts",
        "sync_whiteboard_permissions",
        "sync_whiteboard_elements",
        "sync_whiteboard_scenes"
      ],
      fn table ->
        Postgrex.query!(
          connection,
          "delete from #{table} where tenant_id = $1 and space_id = $2",
          params
        )
      end
    )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection), do: TestProcess.stop(connection)

  defp uuid(value), do: UUID.dump!(value)
end
