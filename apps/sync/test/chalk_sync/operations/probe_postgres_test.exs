defmodule ChalkSync.Operations.ProbePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
  alias ChalkSync.Operations.Probe
  alias ChalkSync.Stateholder.Postgres

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup do
    previous =
      Map.new([:stateholder, :database_connections], fn key ->
        {key, Application.fetch_env(:chalk_sync, key)}
      end)

    {:ok, options} = Database.connection_options(@database_url)
    connection = start_supervised!({Postgrex, options})
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, [connection])

    on_exit(fn ->
      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:chalk_sync, key, value)
        {key, :error} -> Application.delete_env(:chalk_sync, key)
      end)
    end)

    %{connection: connection}
  end

  for {stage, view} <- [
        migration: """
        create temp view goose_db_version as
        select 'private-probe-error'::text::bigint as version_id, true as is_applied, 1 as id
        """,
        pending_age: """
        create temp view sync_lifecycle_intents as
        select null::uuid as lifecycle_intent_id, 'participant_joined'::text as intent_name,
          now() as next_attempt_at, 'private-probe-error'::text::integer as attempt_count,
          null::text as last_error_code, now() as created_at, 'pending'::text as status
        """,
        replication: """
        create temp view pg_stat_replication as
        select 'private-probe-error'::text::pg_lsn as replay_lsn,
          'streaming'::text as state, 'sync'::text as sync_state
        """
      ] do
    @stage stage
    @view view

    test "logs the #{@stage} query stage and SQLSTATE without private error details", %{
      connection: connection
    } do
      Postgrex.query!(connection, @view, [])

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          assert {:error, :database_unavailable} = Probe.run(boot?: true)
        end)

      assert log =~ "\"event\":\"sync.readiness.failed\""
      assert log =~ "\"check\":\"database_query\""
      assert log =~ "\"query_stage\":\"#{@stage}\""
      assert log =~ "\"error_class\":\"Postgrex.Error\""
      assert log =~ "\"sqlstate\":\"22P02\""
      refute log =~ "private-probe-error"
      refute log =~ @database_url
      refute log =~ "create temp view"
    end
  end

  test "logs the role query stage when its connection exits", %{connection: connection} do
    stop_supervised!(Postgrex)
    refute Process.alive?(connection)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, :probe_failed} = Probe.run(boot?: true)
      end)

    assert log =~ "\"query_stage\":\"role\""
    assert log =~ "\"error_class\":\"exit\""
    refute log =~ @database_url
    refute log =~ inspect(connection)
  end
end
