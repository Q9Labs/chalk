defmodule ChalkSync.ObsChainTest do
  # Hop (c) of the end.wrong_screen chain (observability/fixtures/end.wrong_screen/README.md): a real Episode end on Postgres
  # stores its reason, the finalizer reads it back from episodes.end_reason and records sync.episode.ended through the
  # kernel, the production log sink writes its row, and the row is compared with the committed one that hop (d) judges.
  # CHALK_CHAIN_WRITE=1 rewrites it.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias ChalkSync.Obs.{LogSink, Registry}
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

    level = Logger.level()
    Logger.configure(level: :info)
    seed = SyncPostgres.seed_episode(connection, 2, %{}, @ids)

    on_exit(fn ->
      SyncPostgres.cleanup(connection, seed.episode)
      Logger.configure(level: level)
      Application.put_env(:chalk_sync, ChalkSync.Obs, previous)
    end)

    {:ok, seed: seed}
  end

  test "a real Episode end reaches the log as a registry row with the reason Postgres stored",
       ctx do
    :ok = LogSink.attach()
    log = capture_log([level: :info], fn -> end_episode(ctx.seed.episode, "maximum_duration") end)

    [row] =
      log
      |> String.split("\n")
      |> Enum.flat_map(fn line ->
        case Regex.run(~r/\{.*\}/, line) do
          [json] -> [JSON.decode!(json)]
          nil -> []
        end
      end)
      |> Enum.filter(&(&1["name"] == "sync.episode.ended"))

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

  defp end_episode(episode, reason) do
    {:ok, operation} =
      Operation.new("obs_chain_" <> UUID.generate(), :tenant_end_episode, %{"reason" => reason})

    {:ok, %{external_operation_id: id}} = Postgres.begin_internal_operation(episode, operation)

    {:ok, %{result: :applied}} =
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
