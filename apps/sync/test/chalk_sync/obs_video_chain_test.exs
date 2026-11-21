defmodule ChalkSync.ObsVideoChainTest do
  # The video chain's Sync hop: a live camera target stamps sync.media.intent through the real socket
  # request path, and a real Episode end writes sync.episode.ended through the operation finalizer.
  # Both land in the same Postgres telemetry_outbox the relay drains; the test reads them back by seq
  # and writes each video symptom's sync-rows.json hand-off. CHALK_CHAIN_WRITE=1 rewrites them.
  use ExUnit.Case, async: false

  alias ChalkSync.Live.Episode.Publication
  alias ChalkSync.Obs
  alias ChalkSync.Observability.Journey
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.Transport.Socket.LiveRequests
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @fixture_root Path.expand("../../../../observability/fixtures", __DIR__)
  @symptoms ~w(video.camera_wont_start video.camera_stopped video.not_published)
  @intent_at 1_795_599_000_000
  @ended_at 1_795_599_600_000
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
    previous = Application.get_env(:chalk_sync, Obs)
    # Two pinned instants: the intent stamp first, then the Episode's end far later in the window.
    {:ok, times} = Agent.start_link(fn -> [@intent_at] end)
    {:ok, ids} = Agent.start_link(fn -> 0 end)

    Application.put_env(
      :chalk_sync,
      Obs,
      Keyword.merge(previous,
        source_id: "e1000000-0000-4000-8000-000000000001",
        clock: fn -> Agent.get_and_update(times, fn [t | rest] -> {t, rest ++ [@ended_at]} end) end,
        event_id: fn ->
          n = Agent.get_and_update(ids, fn n -> {n + 1, n + 1} end)
          "b2000000-0000-4000-8000-#{String.pad_leading(Integer.to_string(n), 12, "0")}"
        end,
        seq: fn -> Agent.get(ids, & &1) end
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
      Postgrex.query!(connection, "delete from telemetry_outbox where tenant_id = $1", [
        UUID.dump!(seed.episode.tenant_id)
      ])

      Postgrex.query!(connection, "delete from telemetry_sources where tenant_id = $1", [
        UUID.dump!(seed.episode.tenant_id)
      ])

      SyncPostgres.cleanup(connection, seed.episode)
      Application.put_env(:chalk_sync, Obs, previous)
      for pid <- [times, ids], do: if(Process.alive?(pid), do: Agent.stop(pid))
    end)

    {:ok, seed: seed}
  end

  test "a camera intent stamp and a real Episode end enqueue evidence for the video chains", ctx do
    stamp_camera_intent()
    end_episode(ctx.seed.episode, "maximum_duration")

    rows = outbox_rows(ctx)
    assert length(rows) == 2, "expected intent and ended rows, got #{inspect(Enum.map(rows, & &1["name"]))}"

    [intent, ended] = rows
    assert intent["name"] == "sync.media.intent"
    assert intent["source"] == "camera"
    assert intent["enabled"] == true
    assert intent["participant_id"] == @participant
    assert intent["kind"] == "fact"
    assert intent["est_server_ms"] == @intent_at

    assert ended["name"] == "sync.episode.ended"
    assert ended["end_reason"] == stored_reason(ctx)
    assert ended["est_server_ms"] == @ended_at

    fields = MapSet.new(Map.keys(ChalkSync.Obs.Registry.fields()))
    for row <- rows, do: assert(Enum.reject(Map.keys(row), &MapSet.member?(fields, &1)) == [])

    for symptom <- @symptoms, do: committed(symptom, rows)
  end

  # The real socket request path: a live set_camera_enabled target stamps sync.media.intent, which the
  # sink enqueues into telemetry_outbox.
  defp stamp_camera_intent do
    coordinator =
      spawn_link(fn ->
        receive do
          {:"$gen_call", from, {:live_target, _socket, _identity, target}} ->
            GenServer.reply(from, {:ok, Publication.live_result(target, :confirmed)})
        end
      end)

    episode = %EpisodeKey{
      tenant_id: @ids.tenant_id,
      space_id: @ids.space_id,
      episode_id: @ids.episode_id
    }

    identity = %Identity{episode: episode, participant_id: @participant, participant_generation: 1}

    state = %{
      phase: :live,
      coordinator: coordinator,
      identity: identity,
      observability: %{Journey.new_context() | session_id: "chain-video-1"}
    }

    target = %{
      operation_id: "b2000000-0000-4000-8000-0000000000ff",
      name: "set_camera_enabled",
      enabled: true
    }

    assert {:push, {:text, _frame}, _next} = LiveRequests.live_target(target, state)
  end

  defp outbox_rows(ctx) do
    # The sink writes one telemetry_outbox row per record; the flush is asynchronous, so wait for both.
    wait_for(fn ->
      %{rows: rows} =
        Postgrex.query!(
          ctx.connection,
          """
          select payload->0->'attributes' as row from telemetry_outbox
          where tenant_id = $1 order by (payload->0->'attributes'->>'seq')::int
          """,
          [UUID.dump!(ctx.seed.episode.tenant_id)]
        )

      rows = Enum.map(rows, fn [row] -> row end)
      if length(rows) >= 2, do: rows, else: nil
    end)
  end

  defp wait_for(fun, attempts \\ 50)
  defp wait_for(_fun, 0), do: raise("telemetry_outbox rows never arrived")
  defp wait_for(fun, attempts) do
    case fun.() do
      nil ->
        Process.sleep(50)
        wait_for(fun, attempts - 1)

      value ->
        value
    end
  end

  defp end_episode(episode, reason) do
    {:ok, operation} =
      Operation.new("obs_video_chain_" <> UUID.generate(), :tenant_end_episode, %{"reason" => reason})

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

  defp committed(symptom, rows) do
    # schema_ver hashes the whole registry, so any registry edit changes it; every other field is pinned and compared.
    stripped = Enum.map(rows, &Map.delete(&1, "schema_ver"))
    path = Path.join([@fixture_root, symptom, "chain", "sync-rows.json"])
    File.mkdir_p!(Path.dirname(path))

    if System.get_env("CHALK_CHAIN_WRITE") == "1",
      do: File.write!(path, JSON.encode!(stripped) <> "\n")

    assert JSON.decode!(File.read!(path)) == stripped, "#{path} is stale: rerun this hop with CHALK_CHAIN_WRITE=1"
  end
end
