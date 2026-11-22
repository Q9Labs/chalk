defmodule ChalkSync.ObsChainTest do
  # A real Episode end writes its kernel record to the same outbox the API drains.
  # In chain replay this also runs the API upload, relay, and live reader on this Episode.
  use ExUnit.Case, async: false

  alias ChalkSync.Obs.Registry
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @chain Path.expand("../../../../observability/fixtures/end.wrong_screen/chain", __DIR__)
  @ended_at 1_795_600_000_000
  @event_id "7db7df2b-9dd7-420b-8bab-baaab9efe617"
  @participant "a1000000-0000-4000-8000-000000000001"
  @ids %{
    tenant_id: "c1000000-0000-4000-8000-000000000001",
    space_id: "d1000000-0000-4000-8000-000000000001",
    episode_id: "0f8fad5b-d9cb-469f-a165-70867728950e"
  }

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 2)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    previous = Application.get_env(:chalk_sync, ChalkSync.Obs)

    Application.put_env(
      :chalk_sync,
      ChalkSync.Obs,
      Keyword.merge(previous,
        source_id: "e1000000-0000-4000-8000-000000000001",
        clock: fn -> @ended_at end,
        event_id: fn -> @event_id end,
        seq: fn -> 1 end
      )
    )

    seed =
      SyncPostgres.seed_episode(
        connection,
        1,
        %{},
        Map.put(@ids, :participants, [%{id: @participant}])
      )

    on_exit(fn ->
      Postgrex.query!(connection, "delete from telemetry_sources where tenant_id = $1", [
        UUID.dump!(seed.episode.tenant_id)
      ])

      SyncPostgres.cleanup(connection, seed.episode)
      Application.put_env(:chalk_sync, ChalkSync.Obs, previous)
    end)

    {:ok, seed: seed}
  end

  for scenario <- ["positive", "healthy"] do
    @scenario scenario
    test "a real Episode end enqueues evidence for the #{scenario} chain", ctx do
      assert_end_record(ctx)
      if System.get_env("CHALK_CHAIN_LIVE") == "1", do: verify_live(ctx, @scenario)
    end
  end

  test "an end commits with its witness even when the Tenant's outbox is full", ctx do
    tenant = UUID.dump!(ctx.seed.episode.tenant_id)

    Postgrex.query!(
      ctx.connection,
      "insert into telemetry_outbox_usage (tenant_id, max_bytes) values ($1, 0)",
      [tenant]
    )

    on_exit(fn ->
      Postgrex.query!(ctx.connection, "delete from telemetry_outbox_usage where tenant_id = $1", [
        tenant
      ])
    end)

    end_episode_result(ctx.seed.episode, "maximum_duration")

    %{rows: [[status]]} =
      Postgrex.query!(ctx.connection, "select status from episodes where id = $1", [
        UUID.dump!(ctx.seed.episode.episode_id)
      ])

    assert status == "ended"

    assert %{rows: [[1]]} =
             Postgrex.query!(
               ctx.connection,
               "select count(*)::int from telemetry_outbox where tenant_id = $1",
               [tenant]
             )
  end

  defp assert_end_record(ctx) do
    end_episode(ctx.seed.episode, "maximum_duration")

    %{rows: [[row]]} =
      Postgrex.query!(
        ctx.connection,
        """
        select payload->0->'attributes' from telemetry_outbox where tenant_id = $1
        """,
        [UUID.dump!(ctx.seed.episode.tenant_id)]
      )

    assert row["end_reason"] == stored_reason(ctx)

    assert %{
             "kind" => "fact",
             "module" => "sync",
             "clock_state" => "server",
             "est_server_ms" => @ended_at
           } = row

    assert row["schema_ver"] == Registry.schema_ver()

    assert Map.take(row, ["tenant_id", "space_id", "episode_id"]) ==
             Map.new(@ids, fn {key, value} -> {Atom.to_string(key), value} end)

    fields = MapSet.new(Map.keys(Registry.fields()))
    assert Enum.reject(Map.keys(row), &MapSet.member?(fields, &1)) == []

    # schema_ver hashes the whole registry, so any registry edit changes it; every other field is pinned and compared.
    committed = committed_row(row)
    assert Map.delete(row, "schema_ver") == Map.delete(committed, "schema_ver")
    assert Map.has_key?(committed, "schema_ver")
  end

  defp verify_live(ctx, scenario) do
    started = DateTime.from_unix!(@ended_at - 3_600_000, :millisecond)
    ended = DateTime.from_unix!(@ended_at, :millisecond)

    Postgrex.query!(
      ctx.connection,
      """
      update episodes set created_at = $1, started_at = $1, ended_at = $2 where id = $3
      """,
      [started, ended, UUID.dump!(ctx.seed.episode.episode_id)]
    )

    Postgrex.query!(
      ctx.connection,
      """
      update participants set created_at = $1, joined_at = $1, left_at = $2 where id = $3
      """,
      [started, ended, UUID.dump!(@participant)]
    )

    {output, status} =
      System.cmd(
        "go",
        ["test", "./internal/httpapi", "-run", "TestTelemetryChainEndWrongScreen/#{scenario}$"],
        cd: Path.expand("../../../api", __DIR__),
        env: [
          {"CHALK_TELEMETRY_TEST_DATABASE_URL", @database_url},
          {"CHALK_CHAIN_EXISTING_EPISODE", "1"},
          {"CHALK_CHAIN_WRITE", "0"}
        ],
        stderr_to_stdout: true
      )

    assert status == 0, output
  end

  defp end_episode(episode, reason) do
    {:ok, %{result: :applied}} = end_episode_result(episode, reason)
  end

  defp end_episode_result(episode, reason) do
    {:ok, operation} =
      Operation.new("obs_chain_" <> UUID.generate(), :tenant_end_episode, %{"reason" => reason})

    {:ok, %{external_operation_id: id}} = Postgres.begin_internal_operation(episode, operation)

    Postgres.finalize_operation(episode, id, {:applied, :episode_ended, %{"reason" => reason}})
  end

  defp stored_reason(ctx) do
    %{rows: [[reason]]} =
      Postgrex.query!(ctx.connection, "select end_reason from episodes where id = $1", [
        UUID.dump!(ctx.seed.episode.episode_id)
      ])

    reason
  end

  defp committed_row(row) do
    path = Path.join(@chain, "sync-rows.json")

    if System.get_env("CHALK_CHAIN_WRITE") == "1",
      do: File.write!(path, JSON.encode!([row]) <> "\n")

    [committed] = path |> File.read!() |> JSON.decode!()
    committed
  end
end
