defmodule ChalkSync.Retention.CleanupWorkerTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  @now ~U[2026-07-12 00:00:00.000000Z]
  @retention_seconds 7 * 24 * 60 * 60

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

  test "cleans history at seven days and records the verified terminal checkpoint", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_session(connection, @retention_seconds, command?: true)
    cleanup_fixture(connection, fixture)
    before = control_counters(connection, fixture)

    %{
      event_count: event_count,
      event_bytes: event_bytes,
      receipt_count: receipt_count,
      receipt_bytes: receipt_bytes,
      lifecycle_intent_count: lifecycle_intent_count,
      lifecycle_intent_bytes: lifecycle_intent_bytes
    } = before

    assert {:ok,
            %Result{
              sessions: 1,
              event_rows: ^event_count,
              event_bytes: ^event_bytes,
              receipt_rows: ^receipt_count,
              receipt_bytes: ^receipt_bytes,
              lifecycle_intent_rows: ^lifecycle_intent_count,
              lifecycle_intent_bytes: ^lifecycle_intent_bytes
            }} = run_cleanup(connection)

    assert history_counts(connection, fixture) == [0, 0, 0]

    assert [
             [
               before.revision,
               before.digest,
               before.event_count,
               @now,
               before.event_count,
               before.event_bytes,
               before.receipt_count,
               before.receipt_bytes,
               before.lifecycle_intent_count,
               before.lifecycle_intent_bytes
             ]
           ] == checkpoint(connection, fixture)

    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    assert recovery.mode == :terminal
    assert recovery.head.revision == before.revision
    assert recovery.terminal_reason == :session_ended
    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection)
  end

  test "preserves active, pending, and in-window Session history", %{
    connections: connections
  } do
    connection = hd(connections)

    active = SyncPostgres.seed_pending_join(connection)
    cleanup_fixture(connection, active)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(active.session, active.lifecycle_intent_id)

    in_window = seed_ended_session(connection, @retention_seconds - 1)
    cleanup_fixture(connection, in_window)

    pending = seed_ended_session(connection, @retention_seconds + 1)
    cleanup_fixture(connection, pending)
    mark_intent_pending(connection, pending)

    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection)

    for fixture <- [active, in_window, pending] do
      assert [events, _receipts, intents] = history_counts(connection, fixture)
      assert events > 0
      assert intents > 0
      assert [[nil]] = cleaned_at(connection, fixture)
    end
  end

  test "honors the small batch bound", %{connections: connections} do
    connection = hd(connections)

    fixtures =
      Enum.map(1..3, fn _index ->
        fixture = seed_ended_session(connection, @retention_seconds + 1)
        cleanup_fixture(connection, fixture)
        fixture
      end)

    assert {:ok, %Result{sessions: 2}} = run_cleanup(connection, batch_size: 2)

    cleaned = Enum.count(fixtures, fn fixture -> checkpointed?(connection, fixture) end)
    assert cleaned == 2

    assert {:ok, %Result{sessions: 1}} = run_cleanup(connection, batch_size: 2)
    assert Enum.all?(fixtures, &checkpointed?(connection, &1))
  end

  test "skips a concurrently locked eligible control row", %{connections: connections} do
    [locker, worker | _rest] = connections
    locked = seed_ended_session(locker, @retention_seconds + 2)
    cleanup_fixture(locker, locked)
    available = seed_ended_session(locker, @retention_seconds + 1)
    cleanup_fixture(locker, available)
    parent = self()

    task =
      Task.async(fn ->
        Postgrex.transaction(locker, fn transaction ->
          Postgrex.query!(
            transaction,
            "select session_id from sync_session_control where tenant_id = $1 and session_id = $2 for update",
            session_ids(locked)
          )

          send(parent, :control_locked)

          receive do
            :release_control -> :ok
          end
        end)
      end)

    assert_receive :control_locked
    assert {:ok, %Result{sessions: 1}} = run_cleanup(worker, batch_size: 1)
    refute checkpointed?(worker, locked)
    assert checkpointed?(worker, available)

    send(task.pid, :release_control)
    assert {:ok, :ok} = Task.await(task)
  end

  test "rolls back when the independent fold detects corruption", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_session(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and session_id = $2 and revision = 1",
      session_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [events, _receipts, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)
  end

  test "database rejects an incomplete retention checkpoint", %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    cleanup_fixture(connection, fixture)

    assert_raise Postgrex.Error, fn ->
      Postgrex.query!(
        connection,
        "update sync_session_control set retention_cleaned_at = $3 where tenant_id = $1 and session_id = $2",
        session_ids(fixture) ++ [@now]
      )
    end

    refute checkpointed?(connection, fixture)
  end

  defp seed_ended_session(connection, age_seconds, options \\ []) do
    fixture = SyncPostgres.seed_pending_join(connection)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    if Keyword.get(options, :command?, false) do
      assert {:ok, command} = Command.new("retention-command-0001", :raise_hand, %{})
      assert {:ok, %{result: :committed}} = Postgres.decide_command(fixture.identity, command)
    end

    fixture = SyncPostgres.request_pending_end(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.end_lifecycle_intent_id)

    ended_at = DateTime.add(@now, -age_seconds, :second)

    Postgrex.query!(
      connection,
      "update room_sessions set ended_at = $3 where tenant_id = $1 and id = $2",
      session_ids(fixture) ++ [ended_at]
    )

    fixture
  end

  defp run_cleanup(connection, options \\ []) do
    CleanupWorker.run_once(connection, Keyword.put(options, :clock, fn -> @now end))
  end

  defp control_counters(connection, fixture) do
    [
      [
        revision,
        digest,
        event_count,
        event_bytes,
        receipt_count,
        receipt_bytes,
        intent_count,
        intent_bytes
      ]
    ] =
      Postgrex.query!(
        connection,
        """
        select
          control_revision,
          state_digest,
          participant_event_count + lifecycle_event_count,
          participant_event_bytes + lifecycle_event_bytes,
          receipt_count,
          receipt_bytes,
          lifecycle_intent_count,
          lifecycle_intent_bytes
        from sync_session_control
        where tenant_id = $1 and session_id = $2
        """,
        session_ids(fixture)
      ).rows

    %{
      revision: revision,
      digest: digest,
      event_count: event_count,
      event_bytes: event_bytes,
      receipt_count: receipt_count,
      receipt_bytes: receipt_bytes,
      lifecycle_intent_count: intent_count,
      lifecycle_intent_bytes: intent_bytes
    }
  end

  defp checkpoint(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      select
        retention_checkpoint_revision,
        retention_checkpoint_state_digest,
        retention_checkpoint_event_count,
        retention_cleaned_at,
        retention_deleted_event_rows,
        retention_deleted_event_bytes,
        retention_deleted_receipt_rows,
        retention_deleted_receipt_bytes,
        retention_deleted_lifecycle_intent_rows,
        retention_deleted_lifecycle_intent_bytes
      from sync_session_control
      where tenant_id = $1 and session_id = $2
      """,
      session_ids(fixture)
    ).rows
  end

  defp history_counts(connection, fixture) do
    [[events, receipts, intents]] =
      Postgrex.query!(
        connection,
        """
        select
          (select count(*) from sync_control_events where tenant_id = $1 and session_id = $2),
          (select count(*) from sync_command_receipts where tenant_id = $1 and session_id = $2),
          (select count(*) from sync_lifecycle_intents where tenant_id = $1 and session_id = $2)
        """,
        session_ids(fixture)
      ).rows

    [events, receipts, intents]
  end

  defp mark_intent_pending(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set status = 'pending', applied_event_id = null, applied_revision = null, completed_at = null
      where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
      """,
      session_ids(fixture) ++ [UUID.dump!(fixture.end_lifecycle_intent_id)]
    )
  end

  defp cleaned_at(connection, fixture) do
    Postgrex.query!(
      connection,
      "select retention_cleaned_at from sync_session_control where tenant_id = $1 and session_id = $2",
      session_ids(fixture)
    ).rows
  end

  defp checkpointed?(connection, fixture), do: cleaned_at(connection, fixture) != [[nil]]

  defp cleanup_fixture(connection, fixture) do
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)
  end

  defp session_ids(fixture),
    do: [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)]

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
