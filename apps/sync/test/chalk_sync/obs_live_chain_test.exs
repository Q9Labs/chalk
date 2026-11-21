defmodule ChalkSync.ObsLiveChainTest do
  # Slice 13's Sync hop: a real notification insert, then ChalkSync.Live.Introspection
  # delivers the request to the seat's sockets on real Postgres and writes the
  # delivery the db source later reads. A registered live socket proves delivered(n);
  # no coordinator proves target_unavailable(no_socket).
  #
  # Chain replay: the Obs kernel's clock, event_id and seq, the request ids, and
  # the row timestamps are pinned, so a CHALK_CHAIN_WRITE=1 run produces exactly
  # the committed JSON.
  use ExUnit.Case, async: false

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Live.Introspection
  alias ChalkSync.Obs
  alias ChalkSync.Stateholder.{EpisodeKey, Identity, Postgres}
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @chain_root Path.expand("../../../../observability/fixtures", __DIR__)
  @tenant "c1000000-0000-4000-8000-000000000001"
  @space "d1000000-0000-4000-8000-000000000001"
  @episode "1f8fad5b-d9cb-469f-a165-70867728950e"
  @participant "a1000000-0000-4000-8000-000000000001"
  @source "e1000000-0000-4000-8000-000000000001"
  @requested_ms 1_795_599_900_000
  @expires_ms @requested_ms + 60_000

  # Each scenario: whether the seat's socket answers inside expires_at.
  @scenarios %{
    "live.target_unreachable" => %{"positive" => :no_socket, "healthy" => :delivered_ack},
    "live.no_reply" => %{"positive" => :delivered_silent, "healthy" => :delivered_ack},
    "live.upload_missing" => %{"positive" => :delivered_ack, "healthy" => :delivered_ack}
  }

  # A fixed request id per run so committed chain JSON replays byte-for-byte.
  @request_ids %{
    {"live.target_unreachable", "positive"} => "f1000000-0000-4000-8000-000000000001",
    {"live.target_unreachable", "healthy"} => "f1000000-0000-4000-8000-000000000002",
    {"live.no_reply", "positive"} => "f1000000-0000-4000-8000-000000000003",
    {"live.no_reply", "healthy"} => "f1000000-0000-4000-8000-000000000004",
    {"live.upload_missing", "positive"} => "f1000000-0000-4000-8000-000000000005",
    {"live.upload_missing", "healthy"} => "f1000000-0000-4000-8000-000000000006"
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
    counter = :atomics.new(1, [])

    Application.put_env(
      :chalk_sync,
      ChalkSync.Obs,
      Keyword.merge(previous,
        source_id: @source,
        clock: fn -> @requested_ms end,
        event_id: fn -> "e1000000-0000-4000-8000-00000000" <> padded(counter) end,
        seq: fn -> 1 end
      )
    )

    seed =
      SyncPostgres.seed_episode(
        connection,
        1,
        %{},
        %{tenant_id: @tenant, space_id: @space, episode_id: @episode, participants: [%{id: @participant}]}
      )

    Postgrex.query!(connection, "update participants set status = 'active', left_at = null where tenant_id = $1 and id = $2", [
      UUID.dump!(@tenant),
      UUID.dump!(@participant)
    ])

    on_exit(fn ->
      Postgrex.query!(connection, "delete from telemetry_sources where tenant_id = $1", [
        UUID.dump!(@tenant)
      ])

      Postgrex.query!(connection, "delete from live_introspection_requests where tenant_id = $1", [
        UUID.dump!(@tenant)
      ])

      Postgrex.query!(connection, "delete from telemetry_outbox where tenant_id = $1", [
        UUID.dump!(@tenant)
      ])

      SyncPostgres.cleanup(connection, seed.episode)
      Application.put_env(:chalk_sync, ChalkSync.Obs, previous)
    end)

    {:ok, seed: seed}
  end

  for {code, runs} <- @scenarios, {run, mode} <- runs do
    @code code
    @run run
    @mode mode
    test "#{@code} #{@run}: the seat's delivery lands on the row", ctx do
      request_id = @request_ids[{@code, @run}]
      insert_request(ctx.connection, request_id)
      identity = identity()
      coordinator = if @mode != :no_socket, do: registered_socket(identity), else: nil

      Introspection.deliver(@tenant, @episode, request_id)

      if coordinator != nil do
        assert_receive {:sync_v1_live_frame, ^coordinator, %{"type" => "live_request"}}, 1_000
      end

      if @mode == :delivered_ack do
        # The client's request_ack travels both hops the socket takes: the
        # coordinator marks the seat's connection answered, and the socket's
        # frame handler emits the live_request.ack record as the evidence.
        assert :ok = Coordinator.acknowledge_request(coordinator, identity, request_id)

        assert {:ok, fields} = Introspection.acknowledge(identity, request_id)
        assert fields[:live_request_id] == request_id
        Obs.fact("live_request.ack", fields)
      end

      pin_request_times(ctx.connection, request_id)

      %{rows: [[delivery, sockets, unavailable_reason]]} =
        Postgrex.query!(
          ctx.connection,
          "select delivery, sockets, unavailable_reason from live_introspection_requests where id = $1",
          [UUID.dump!(request_id)]
        )

      case @mode do
        :no_socket -> assert delivery == "target_unavailable(no_socket)"
        _ -> assert String.starts_with?(delivery, "delivered")
      end

      rows = sync_kernel_rows(ctx.connection) ++ [live_request_db_row(ctx.connection, request_id)]
      compare_chain(Path.join([@chain_root, @code, "chain", "sync-rows.#{@code}.#{@run}.json"]), rows)
      _ = unavailable_reason
      _ = sockets
    end
  end

  defp padded(counter), do: :atomics.add_get(counter, 1, 1) |> Integer.to_string(16) |> String.pad_leading(4, "0")

  defp identity do
    %Identity{
      episode: %EpisodeKey{tenant_id: @tenant, space_id: @space, episode_id: @episode},
      participant_id: @participant,
      participant_generation: 1,
      protocol_version: 1
    }
  end

  # The live socket state a negotiated client leaves behind: subscribed in
  # mode :live, registered in live.requests.connections, and carrying the
  # live_introspection option. The subscription and registration go through
  # the real coordinator; the negotiated flag is stamped the same place the
  # socket handshake leaves it.
  defp registered_socket(identity) do
    {:ok, recovery} = Postgres.recover_episode(identity.episode, nil)
    {:ok, coordinator} = Coordinator.subscribe(identity, recovery.head, self())
    socket = self()

    :sys.replace_state(coordinator, fn state ->
      subscriber =
        state.sockets[socket]
        |> Map.put(:identity, identity)
        |> Map.put(:protocol_options, %{live_introspection: true})
      requests = %{
        state.live.requests
        | connections:
            Map.put(state.live.requests.connections, identity.participant_id, MapSet.new([socket]))
      }

      %{state | sockets: Map.put(state.sockets, socket, subscriber), live: %{state.live | requests: requests}}
    end)

    coordinator
  end

  # The request row the API's insert writes: the same statement, the same
  # status snapshot, so the delivery has a real row to answer.
  defp insert_request(connection, request_id) do
    %{rows: [[_]]} =
      Postgrex.query!(
        connection,
        """
        insert into live_introspection_requests (
          id, tenant_id, episode_id, participant_id, expires_at,
          participant_status, seat_left_at, episode_status
        )
        select $1, $2, $3, p.id, now() + interval '60 seconds', p.status, p.left_at, e.status
        from episodes e
        left join participants p on p.tenant_id = e.tenant_id and p.episode_id = e.id and p.id = $4
        where e.tenant_id = $2 and e.id = $3
        returning id
        """,
        [UUID.dump!(request_id), UUID.dump!(@tenant), UUID.dump!(@episode), UUID.dump!(@participant)]
      )

    request_id
  end

  # The delivery writes now() stamps; the chain pins them to fixed values so
  # the committed rows replay byte-for-byte.
  defp pin_request_times(connection, request_id) do
    Postgrex.query!(
      connection,
      """
      update live_introspection_requests
      set requested_at = $2::timestamptz, expires_at = $3::timestamptz,
          delivered_at = case when delivered_at is null then null else $2::timestamptz end
      where tenant_id = $1 and id = $4
      """,
      [
        UUID.dump!(@tenant),
        DateTime.from_unix!(@requested_ms, :millisecond),
        DateTime.from_unix!(@expires_ms, :millisecond),
        UUID.dump!(request_id)
      ]
    )
  end

  # The sync kernel's outbox rows for this chain: the deliver decision and any
  # ack, decoded to the kernel record shape.
  defp sync_kernel_rows(connection) do
    %{rows: rows} =
      Postgrex.query!(
        connection,
        "select payload->0->'attributes' from telemetry_outbox where tenant_id = $1 order by id",
        [UUID.dump!(@tenant)]
      )

    Enum.map(rows, fn [row] -> Map.drop(row, ["schema_ver", "decision_id"]) end)
  end

  # The post-delivery request row as the db source's live.db_request event.
  defp live_request_db_row(connection, request_id) do
    %{rows: [[row]]} =
      Postgrex.query!(
        connection,
        """
        select jsonb_strip_nulls(jsonb_build_object(
          'live_request_id', id, 'request_status', coalesce(delivery, 'pending'),
          'requested_ms', (extract(epoch from requested_at) * 1000)::bigint,
          'expires_ms', (extract(epoch from expires_at) * 1000)::bigint,
          'participant_status', participant_status, 'episode_status', episode_status,
          'seat_left_ms', (extract(epoch from seat_left_at) * 1000)::bigint,
          'delivery', delivery, 'delivered_ms', (extract(epoch from delivered_at) * 1000)::bigint,
          'sockets', sockets, 'unavailable_reason', unavailable_reason,
          'participant_id', participant_id
        ))
        from live_introspection_requests where tenant_id = $1 and id = $2
        """,
        [UUID.dump!(@tenant), UUID.dump!(request_id)]
      )

    Map.merge(row, %{
      "event_id" => "e1000000-0000-4000-8000-000000009999",
      "name" => "live.db_request",
      "kind" => "fact",
      "module" => "checker",
      "env" => "test",
      "platform" => "server",
      "clock_state" => "server",
      "est_server_ms" => @expires_ms,
      "duration_ms" => 0,
      "source_id" => @source,
      "tenant_id" => @tenant,
      "episode_id" => @episode
    })
  end

  defp compare_chain(path, rows) do
    if System.get_env("CHALK_CHAIN_WRITE") == "1" do
      File.mkdir_p!(Path.dirname(path))
      File.write!(path, JSON.encode!(rows) <> "\n")
    end

    committed = path |> File.read!() |> JSON.decode!()
    assert committed == rows, "#{path} is stale: run the chain in order with CHALK_CHAIN_WRITE=1"
  end
end
