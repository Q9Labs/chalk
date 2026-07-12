defmodule ChalkSync.Stateholder.PostgresLifecycleTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

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

  test "applies a pending admission atomically and resolves every retry", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    assert {:ok, before_apply} = Postgres.recover(fixture.identity, nil)
    assert before_apply.mode == :terminal
    assert before_apply.terminal_reason == :participant_inactive

    assert {:ok, applied} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert applied.result == :applied
    assert applied.revision == 1
    assert applied.event.name == "participant_joined"
    assert applied.event.lifecycle_intent_id == fixture.lifecycle_intent_id

    assert {:ok, duplicate} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert duplicate.result == :already_applied
    assert duplicate.event_id == applied.event_id
    assert duplicate.revision == applied.revision

    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    assert recovery.mode == :snapshot
    assert recovery.head.revision == 1

    assert hd(recovery.snapshot["participants"])["participant_session_id"] ==
             fixture.identity.participant_session_id

    assert [
             [0, 2, 32_768, 2, 32_768, "active"]
           ] =
             query_rows(fixture, """
             select
               c.snapshot_reserved_bytes,
               c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes,
               c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes,
               p.status
             from sync_session_control c
             join participants p
               on p.tenant_id = c.tenant_id and p.session_id = c.session_id
             where c.tenant_id = $1 and c.session_id = $2
             """)
  end

  test "concurrent nodes apply one lifecycle event", %{connections: connections} do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)
      end)

    outcomes = Enum.map([Task.await(first), Task.await(second)], fn {:ok, result} -> result end)
    assert outcomes |> Enum.map(& &1.result) |> Enum.sort() == [:already_applied, :applied]
    assert Enum.uniq(Enum.map(outcomes, & &1.event_id)) |> length() == 1

    assert [[1]] =
             query_rows(
               fixture,
               "select count(*) from sync_control_events where tenant_id = $1 and session_id = $2"
             )
  end

  test "participant removal consumes its reserve and becomes terminal for the old token", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    fixture = SyncPostgres.request_pending_leave(hd(connections), fixture)

    assert {:ok, leave} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.leave_lifecycle_intent_id)

    assert leave.result == :applied
    assert leave.revision == 2
    assert leave.event.name == "participant_left"

    assert {:ok, terminal} = Postgres.recover(fixture.identity, nil)
    assert terminal.mode == :terminal
    assert terminal.terminal_reason == :participant_inactive
    assert terminal.head.revision == 2

    assert [[1, 16_384, 1, 16_384, "left"]] =
             query_rows(fixture, """
             select
               c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes,
               c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes,
               p.status
             from sync_session_control c
             join participants p
               on p.tenant_id = c.tenant_id and p.session_id = c.session_id
             where c.tenant_id = $1 and c.session_id = $2
             """)
  end

  test "session end supersedes pending joins and releases every lifecycle reserve", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    fixture = SyncPostgres.request_pending_end(hd(connections), fixture)

    assert {:ok, ended} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.end_lifecycle_intent_id)

    assert ended.result == :applied
    assert ended.event.name == "session_ended"
    assert ended.revision == 1

    assert {:ok, terminal} = Postgres.recover(fixture.identity, nil)
    assert terminal.mode == :terminal
    assert terminal.terminal_reason == :session_ended
    assert terminal.head.revision == 1

    assert [[0, 0, 0, 0, 0, "ended", "left"]] =
             query_rows(fixture, """
             select
               c.snapshot_reserved_bytes,
               c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes,
               c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes,
               s.status,
               p.status
             from sync_session_control c
             join room_sessions s
               on s.tenant_id = c.tenant_id and s.id = c.session_id
             join participants p
               on p.tenant_id = c.tenant_id and p.session_id = c.session_id
             where c.tenant_id = $1 and c.session_id = $2
             """)

    assert [["superseded", "superseded_by_session_end"]] =
             query_rows(
               fixture,
               """
               select status, terminal_reason
               from sync_lifecycle_intents
               where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
               """,
               [UUID.dump!(fixture.lifecycle_intent_id)]
             )
  end

  test "resolves lifecycle success after the commit response is lost", %{connections: connections} do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    Application.put_env(:chalk_sync, :lifecycle_fault_hook, fn point, _context ->
      if point == :after_commit_before_reply, do: raise("lost lifecycle commit response")
    end)

    try do
      assert {:ok, decision} =
               Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

      assert decision.result == :already_applied
      assert decision.revision == 1
    after
      Application.delete_env(:chalk_sync, :lifecycle_fault_hook)
    end
  end

  defp query_rows(fixture, sql, extra_params \\ []) do
    params =
      [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)] ++
        extra_params

    Database.connection(fixture.session)
    |> Postgrex.query!(sql, params)
    |> Map.fetch!(:rows)
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
