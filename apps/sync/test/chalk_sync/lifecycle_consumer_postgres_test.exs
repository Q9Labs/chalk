defmodule ChalkSync.LifecycleConsumerPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Operations.Probe
  alias ChalkSync.Operations.Readiness
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @entry_path "/v1/sync?entry_confirmation=1&entry_generation=new"

  setup_all do
    if @database_url do
      previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  @tag :entry_ownership
  test "a newer confirmed entry voids an accepted older Leave through finalization", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "before-reentry")
    current = entry_identity(fixture.identity, 2, "after-reentry")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, _} = Postgres.recover(current, nil)
    {:ok, leave} = Operation.new("inflight_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(first, leave)

    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})

    assert [["active", "joined"]] = entry_rows(connection, current)

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_publication_fences where participant_id=$1",
               [UUID.dump!(current.participant_id)]
             ).rows

    assert [["rejected"]] =
             Postgrex.query!(
               connection,
               "select outcome from sync_command_receipts where external_operation_id=$1",
               [UUID.dump!(id)]
             ).rows

    leave_entry(connection, current, "newer_entry_leave_001")
  end

  @tag :entry_ownership
  test "an older confirmation retry cannot reclaim Leave or cancel the newer entry's Leave", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "older-entry")
    current = entry_identity(fixture.identity, 2, "newer-entry")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(first)
    {:ok, stale} = Operation.new("retried_older_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(first, stale)

    {:ok, own} = Operation.new("newer_own_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(current, own)

    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(first)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})

    assert [["left", "left"]] = entry_rows(connection, current)
  end

  @tag :entry_ownership
  test "a refreshed reconnect Leaves the same entry without another entered", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    original = entry_identity(fixture.identity, 1, "before-refresh")
    refreshed = entry_identity(fixture.identity, 1, "after-refresh")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(original)
    assert {:ok, _} = Postgres.recover(refreshed, nil)
    leave_entry(connection, refreshed, "refreshed_entry_leave_001")
  end

  @tag :entry_generation
  test "entry admission allocates monotonically and resumption cannot choose a future generation",
       %{connections: connections} do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, current} = Postgres.admit_entry(fixture.identity, :new)
    assert current.entry_generation == first.entry_generation + 1
    assert {:ok, resumed} = Postgres.admit_entry(fixture.identity, first.entry_generation)
    assert resumed.entry_generation == first.entry_generation

    assert {:error, :invalid_admission_intent} =
             Postgres.admit_entry(fixture.identity, current.entry_generation + 1)

    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(resumed)
    leave_entry(connection, current, "allocated_entry_leave_001")
    assert {:error, :invalid_admission_intent} = Postgres.confirm_admission(current)
  end

  @tag :entry_generation
  test "a claimed older Leave never reaches the provider across an admitted newer entry", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, current} = Postgres.admit_entry(fixture.identity, :new)
    {:ok, leave} = Operation.new("provider_entry_leave_001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(first, leave)
    assert {:ok, operations} = Postgres.claim_operations(64)

    {_, claimed} =
      Enum.find(operations, fn {_, operation} -> operation.external_operation_id == id end)

    {:ok, adapter} = ChalkSync.Live.MediaPlaneTestAdapter.start_link()
    media = {ChalkSync.Live.MediaPlaneTestAdapter, adapter}
    finalize = &Postgres.finalize_operation/3

    assert :pending =
             ChalkSync.ExternalOperationConsumer.execute_operation(
               fixture.episode,
               claimed,
               media,
               nil,
               finalize
             )

    assert [] == ChalkSync.Live.MediaPlaneTestAdapter.calls(adapter)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    assert :terminal_failure =
             ChalkSync.ExternalOperationConsumer.execute_operation(
               fixture.episode,
               claimed,
               media,
               nil,
               finalize
             )

    assert [] == ChalkSync.Live.MediaPlaneTestAdapter.calls(adapter)
    assert [["active", "joined"]] = entry_rows(connection, current)
    leave_entry(connection, current, "provider_current_leave_001")
  end

  @tag :entry_generation
  test "entry admission waits for already claimed provider work and an abandoned admission expires",
       %{
         connections: connections
       } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    {:ok, leave} = Operation.new("claimed_entry_leave_001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(first, leave)
    assert {:ok, _} = Postgres.claim_operations(64)
    assert :ready = Postgres.prepare_entry_leave(fixture.episode, id)
    assert {:retryable, :admission_pending} = Postgres.admit_entry(fixture.identity, :new)

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(
               fixture.episode,
               id,
               {:failed, :provider_unavailable}
             )

    assert {:ok, abandoned} = Postgres.admit_entry(fixture.identity, :new)
    {:ok, retry} = Operation.new("abandoned_entry_leave_001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: retry_id}} = Postgres.begin_operation(first, retry)
    assert :pending = Postgres.prepare_entry_leave(fixture.episode, retry_id)

    Postgrex.query!(
      connection,
      "update participant_join_seats set issued_entry_expires_at=now()-interval '1 second' where participant_id=$1",
      [UUID.dump!(first.participant_id)]
    )

    assert {:error, :entry_expired} = Postgres.confirm_admission(abandoned)
    assert :ready = Postgres.prepare_entry_leave(fixture.episode, retry_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, retry_id, {:confirmed, :provider})
  end

  @tag :entry_generation
  test "legacy hello allocates ownership without extending the legacy welcome", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    for expected <- [3, 4] do
      {:ok, client} = Client.connect(port, "/v1/sync")
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:json, %{"type" => "welcome"} = welcome, _client} = Client.recv(client)
      refute Map.has_key?(welcome, "entry_generation")

      assert [[^expected]] =
               Postgrex.query!(
                 connection,
                 "select confirmed_entry_generation from participant_join_seats where participant_id=$1",
                 [UUID.dump!(fixture.identity.participant_id)]
               ).rows
    end

    old = %{fixture.identity | entry_generation: 3}
    current = %{fixture.identity | entry_generation: 4}
    {:ok, leave} = Operation.new("legacy_old_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(old, leave)

    leave_entry(connection, current, "legacy_current_entry_leave_001")
  end

  defp entry_identity(identity, generation, old_token) do
    identity |> Map.put(:entry_generation, generation) |> Map.put(:entry_token_id, old_token)
  end

  defp entry_rows(connection, identity) do
    Postgrex.query!(
      connection,
      "select p.status,s.state from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
      [UUID.dump!(identity.participant_id)]
    ).rows
  end

  defp leave_entry(connection, identity, key) do
    {:ok, leave} = Operation.new(key, :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(identity.episode, id, {:confirmed, :provider})

    assert [["left", "left"]] = entry_rows(connection, identity)
  end

  @tag :join_seat_retry
  test "a completed reentry fences an older entry's delayed Leave", %{connections: connections} do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "first-entry")
    current = entry_identity(fixture.identity, 2, "current-entry")

    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    {:ok, stale_leave} = Operation.new("stale_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(first, stale_leave)

    assert [["active", "joined", 2]] =
             Postgrex.query!(
               connection,
               "select p.status,s.state,s.confirmed_entry_generation from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
               [UUID.dump!(current.participant_id)]
             ).rows

    {:ok, current_leave} = Operation.new("current_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :pending}} = Postgres.begin_operation(current, current_leave)
  end

  for state <- ["pending", "cancelled", "expired"] do
    @seat_state state
    @tag :join_seat_retry
    test "retry from #{@seat_state} fences the previous Sync identity", %{
      connections: connections
    } do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

      case @seat_state do
        "cancelled" ->
          assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")

        "expired" ->
          Postgrex.query!(
            connection,
            "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
            [UUID.dump!(fixture.identity.participant_id)]
          )

          assert [["expired"]] = seat_transition(connection, fixture, "expire")

        "pending" ->
          :ok
      end

      assert [["pending"]] = seat_transition(connection, fixture, "retry")

      assert {:error, :stale_participant_generation} =
               Postgres.confirm_admission(fixture.identity)

      assert [["joining", nil, generation]] =
               Postgrex.query!(
                 connection,
                 "select status, first_joined_at, generation from participants where id=$1",
                 [UUID.dump!(fixture.identity.participant_id)]
               ).rows

      assert generation > fixture.identity.participant_generation
      current = %{fixture.identity | participant_generation: generation}
      assert {:ok, %{result: :applied}} = Postgres.confirm_admission(current)
      assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    end
  end

  @tag :join_seat_retry
  test "retry renews both pending-seat deadlines without adding reservations", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    participant = [UUID.dump!(fixture.identity.participant_id)]

    reservations = fn ->
      Postgrex.query!(
        connection,
        "select snapshot_reserved_bytes,lifecycle_reserved_events,lifecycle_reserved_bytes,lifecycle_reserved_intents,lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1",
        [UUID.dump!(fixture.episode.episode_id)]
      ).rows
    end

    before_retry = reservations.()

    Postgrex.query!(
      connection,
      "update participant_join_seats set expires_at=now()+interval '2 seconds' where participant_id=$1",
      participant
    )

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set next_attempt_at=now()+interval '2 seconds' where participant_id=$1",
      participant
    )

    assert [["pending"]] = seat_transition(connection, fixture, "retry")

    assert [[true, true]] =
             Postgrex.query!(
               connection,
               """
               select s.expires_at between now()+interval '115 seconds' and now()+interval '2 minutes',
                 i.next_attempt_at=s.expires_at
               from participant_join_seats s join sync_lifecycle_intents i using(participant_id)
               where s.participant_id=$1 and i.intent_name='participant_joined'
               """,
               participant
             ).rows

    assert reservations.() == before_retry
  end

  @tag :entered_admission
  test "legacy pending admission can recover without confirming attendance", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    refute recovery.mode == :terminal

    assert [["joining", false]] =
             Postgrex.query!(
               connection,
               "select status, first_joined_at is not null from participants where id=$1",
               [UUID.dump!(fixture.identity.participant_id)]
             ).rows
  end

  @tag :legacy_entry
  @tag :entered_admission
  test "a v1 client without entry confirmation confirms its seat and attendance on hello", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, "/v1/sync")
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    refute Map.has_key?(welcome, "entry_confirmation")
    assert [["active", "joined", true]] = entry_row(connection, fixture)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, _client} = Client.recv(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end

  @tag :legacy_entry
  @tag :entered_admission
  test "entered on a socket that never negotiated entry confirmation is refused", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, "/v1/sync")
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    refute Map.has_key?(welcome, "entry_confirmation")
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    client = Client.send_json(client, %{"type" => "entered"})

    assert {:json,
            %{
              "type" => "error",
              "code" => "protocol_error",
              "detail" => "entry_confirmation_not_negotiated"
            }, client} = Client.recv(client)

    client = Client.send_json(client, %{"type" => "ping"})
    assert {:json, %{"type" => "pong"}, _client} = Client.recv(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end

  @tag :entered_admission
  test "entered immediately after recovery_complete is accepted on reconnect", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(fixture.identity)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client = Client.send_json(client, %{"type" => "entered"})
    receive_entered_ack(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end

  @tag :entry_timeout_trace
  @tag :entered_admission
  test "pending entry deadline evicts an expired socket and releases live capacity", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    handler = "entry-timeout-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:entry_closed, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    coordinator = Coordinator.whereis(fixture.episode)
    [socket] = coordinator |> :sys.get_state() |> Map.fetch!(:sockets) |> Map.keys()
    monitor = Process.monitor(coordinator)

    Postgrex.query!(
      connection,
      "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    assert [["expired"]] = seat_transition(connection, fixture, "expire")
    send(socket, :entry_timeout)
    assert {:closed, 1008, "entry timeout", _client} = Client.recv(client)
    assert_receive {:entry_closed, %{reason: :entry_timeout, close_code: 1008}}, 1_000
    assert_receive {:DOWN, ^monitor, :process, ^coordinator, _reason}, 2_000
    assert [["left", "expired", false]] = entry_row(connection, fixture)
  end

  for {case_name, reaped, close_reason, seat_state} <- [
        {"an expired lease", false, "entry timeout", "expired"},
        {"a lease the consumer already expired", true, "entry timeout", "expired"},
        {"a cancelled seat", nil, "policy violation", "cancelled"}
      ] do
    @case_name case_name
    @reaped reaped
    @close_reason close_reason
    @seat_state seat_state
    @tag :entered_admission
    test "entered after recovery on #{@case_name} closes with #{@close_reason}", %{
      connections: connections,
      port: port
    } do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
      client = Client.acknowledge_recovery(client, welcome)
      assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)

      if is_nil(@reaped) do
        assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")
      else
        Postgrex.query!(
          connection,
          "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
          [UUID.dump!(fixture.identity.participant_id)]
        )

        if @reaped, do: assert([["expired"]] = seat_transition(connection, fixture, "expire"))
      end

      client = Client.send_json(client, %{"type" => "entered"})
      assert {:closed, 1008, @close_reason, _client} = Client.recv(client)
      assert [["left", @seat_state, false]] = entry_row(connection, fixture)
    end
  end

  for reaped <- [false, true] do
    @reaped reaped
    @tag :entered_admission
    test "reconnecting after the lease expired before entry closes as entry timeout (reaped: #{@reaped})",
         %{connections: connections, port: port} do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

      Postgrex.query!(
        connection,
        "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
        [UUID.dump!(fixture.identity.participant_id)]
      )

      if @reaped, do: assert([["expired"]] = seat_transition(connection, fixture, "expire"))
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:closed, 1008, "entry timeout", _client} = Client.recv(client)
    end
  end

  @tag :entered_admission
  test "entered from a retried seat's previous generation closes as rejected access", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    assert [["pending"]] = seat_transition(connection, fixture, "retry")
    client = Client.send_json(client, %{"type" => "entered"})
    assert {:closed, 1008, "invalid token", _client} = Client.recv(client)
    assert [["joining", "pending", false]] = entry_row(connection, fixture)
  end

  @tag :entered_admission
  test "hello is cancellable after Sync recovery without attendance, entered confirms exactly once",
       %{connections: connections, port: port} do
    connection = hd(connections)

    for entered <- [false, true] do
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))

      assert {:json, %{"type" => "welcome", "entry_confirmation" => true} = welcome, client} =
               Client.recv(client)

      client = Client.acknowledge_recovery(client, welcome)
      assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
      assert [["joining", "pending", false]] = entry_row(connection, fixture)

      if entered do
        client = Client.send_json(client, %{"type" => "entered"})
        client = receive_entered_ack(client)
        assert [["active", "joined", true]] = entry_row(connection, fixture)
        client = Client.send_json(client, %{"type" => "entered"})
        receive_entered_ack(client)

        assert [[1]] =
                 Postgrex.query!(
                   connection,
                   "select count(*) from sync_control_events where lifecycle_intent_id=$1",
                   [UUID.dump!(fixture.lifecycle_intent_id)]
                 ).rows
      else
        assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")
        assert [["left", "cancelled", false]] = entry_row(connection, fixture)
      end
    end
  end

  @tag :entered_admission
  test "a stale-generation hello closes as rejected access rather than dependency outage", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert [["pending"]] = seat_transition(connection, fixture, "retry")
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:closed, 1008, _reason, _client} = Client.recv(client)
    assert [["joining", "pending", false]] = entry_row(connection, fixture)
  end

  defp receive_entered_ack(client, remaining \\ 8)

  defp receive_entered_ack(client, remaining) when remaining > 0 do
    case Client.recv(client) do
      {:json, %{"type" => "entered_ack"}, client} ->
        client

      {:json, %{"type" => "error"} = frame, _client} ->
        flunk("entered rejected: #{inspect(frame)}")

      {:json, _frame, client} ->
        receive_entered_ack(client, remaining - 1)
    end
  end

  defp entry_row(connection, fixture) do
    Postgrex.query!(
      connection,
      "select p.status,s.state,p.first_joined_at is not null from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    ).rows
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "role" => identity.role || "owner",
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 1,
      "extensions" => [
        %{
          "name" => "collaboration_v2",
          "chat_cursor" => %{"after_sequence" => nil, "retained_floor_sequence" => nil}
        }
      ],
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  defp managed_pending_join(connection) do
    fixture = SyncPostgres.seed_pending_join(connection)

    Postgrex.query!(
      connection,
      """
      insert into participant_join_seats(tenant_id,space_id,episode_id,participant_id,generation,state,expires_at,issued_entry_generation)
      values($1,$2,$3,$4,1,'pending',now()+interval '2 minutes',2)
      """,
      Scope.participant(fixture.identity)
    )

    Postgrex.query!(
      connection,
      "update participants set media_connection_id='attempt-old' where id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    fixture
  end

  defp seat_transition(connection, fixture, action) do
    Postgrex.query!(
      connection,
      "select transition_participant_join_seat($1,$2,$3,$4,1,$5,'attempt-old')",
      Scope.participant(fixture.identity) ++ [action]
    ).rows
  end

  test "records concurrent failures without losing attempts or overflowing the counter", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    assert :ok = Task.await(first)
    assert :ok = Task.await(second)
    assert ["pending", 2, "dependency_unavailable"] = intent_attempt(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set attempt_count = 2147483647 where lifecycle_intent_id = $1",
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    assert :ok =
             Postgres.record_lifecycle_failure(
               fixture.episode,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    assert ["pending", 2_147_483_647, "dependency_unavailable"] =
             intent_attempt(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert ["applied", 2_147_483_647, nil] = intent_attempt(connection, fixture)
  end

  test "defers a full poison page until its durable retry deadline", %{connections: connections} do
    connection = hd(connections)
    poison = Enum.map(1..32, fn _index -> SyncPostgres.seed_pending_join(connection) end)

    on_exit(fn ->
      Enum.each(poison, &SyncPostgres.cleanup(connection, &1.episode))
    end)

    Enum.each(poison, fn fixture ->
      Postgrex.query!(
        connection,
        "update sync_lifecycle_intents set attempt_count = 9 where lifecycle_intent_id = $1",
        [UUID.dump!(fixture.lifecycle_intent_id)]
      )

      assert :ok =
               Postgres.record_lifecycle_failure(
                 fixture.episode,
                 fixture.lifecycle_intent_id,
                 :dependency_unavailable
               )
    end)

    assert {:ok, pending} = Postgres.pending_lifecycle_intents(32)

    for fixture <- poison do
      refute {fixture.episode, fixture.lifecycle_intent_id} in pending
    end
  end

  test "readiness retains bounded diagnostics for an aged retrying lifecycle intent", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    assert :ok =
             Postgres.record_lifecycle_failure(
               fixture.episode,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '1 minute', next_attempt_at = now() + interval '1 minute'
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    readiness =
      start_supervised!({Readiness, name: nil, auto_probe?: false, probe_fun: &Probe.run/0})

    health = Readiness.probe_now(readiness)
    assert health.status == "unready"
    assert health.dependencies.reason == "lifecycle_intent_lag"
    database = health.dependencies.database
    assert database.oldest_pending_lifecycle_intent_ms >= 60_000
    assert database.lifecycle_intents.pending >= 1
    assert database.lifecycle_intents.retrying >= 1
    assert database.lifecycle_intents.due < database.lifecycle_intents.pending
    assert database.lifecycle_intents.oldest_attempt_count == 1
    assert database.lifecycle_intents.oldest_error_code == "dependency_unavailable"

    private_error = "private diagnostic must not escape"

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents set last_error_code = $2 where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id), private_error]
    )

    redacted = Readiness.probe_now(readiness)
    assert redacted.dependencies.database.lifecycle_intents.oldest_error_code == "other"
    refute JSON.encode!(redacted) =~ private_error
    refute JSON.encode!(redacted) =~ fixture.lifecycle_intent_id
    refute JSON.encode!(redacted) =~ fixture.episode.episode_id

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    recovered = Readiness.probe_now(readiness)
    assert recovered.dependencies == %{reason: "required_process_unavailable"}
  end

  defp intent_attempt(connection, fixture) do
    connection
    |> Postgrex.query!(
      """
      select status, attempt_count, last_error_code
      from sync_lifecycle_intents
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )
    |> Map.fetch!(:rows)
    |> then(fn [attempt] -> attempt end)
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection), do: TestProcess.stop(connection)
end
