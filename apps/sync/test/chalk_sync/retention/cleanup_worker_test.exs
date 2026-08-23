defmodule ChalkSync.Retention.CleanupWorkerTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
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

  test "rolls back when the independent fold detects corruption", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [events, _receipts, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)
  end

  defp seed_ended_episode(connection, age_seconds, options \\ []) do
    fixture = SyncPostgres.seed_pending_join(connection)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    if Keyword.get(options, :command?, false) do
      assert {:ok, command} =
               Command.new("retention-command-0001", :set_hand_raised, %{"raised" => true})

      assert {:ok, %{result: :committed}} = Postgres.decide_command(fixture.identity, command)
    end

    assert {:ok, operation} = Operation.new("retention_episode_end", :end_episode, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(fixture.identity, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    age_ended_episode(connection, fixture, age_seconds)

    fixture
  end

  defp age_ended_episode(connection, fixture, age_seconds) do
    ended_at = DateTime.add(@now, -age_seconds, :second)

    Postgrex.query!(
      connection,
      "update episodes set ended_at = $3 where tenant_id = $1 and id = $2",
      episode_ids(fixture) ++ [ended_at]
    )
  end

  defp run_cleanup(connection, options \\ []) do
    CleanupWorker.run_once(connection, Keyword.put(options, :clock, fn -> @now end))
  end

  defp history_counts(connection, fixture) do
    [[events, receipts, intents]] =
      Postgrex.query!(
        connection,
        """
        select
          (select count(*) from sync_control_events where tenant_id = $1 and episode_id = $2),
          (select count(*) from sync_command_receipts where tenant_id = $1 and episode_id = $2),
          (select count(*) from sync_lifecycle_intents where tenant_id = $1 and episode_id = $2)
        """,
        episode_ids(fixture)
      ).rows

    [events, receipts, intents]
  end

  defp cleaned_at(connection, fixture) do
    Postgrex.query!(
      connection,
      "select retention_cleaned_at from sync_episode_control where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    ).rows
  end

  defp checkpointed?(connection, fixture), do: cleaned_at(connection, fixture) != [[nil]]

  defp cleanup_fixture(connection, fixture) do
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
  end

  defp episode_ids(fixture),
    do: [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)]

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
