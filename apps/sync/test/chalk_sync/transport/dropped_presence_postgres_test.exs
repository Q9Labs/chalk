defmodule ChalkSync.Transport.DroppedPresencePostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.RecordingPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.PresenceRuntime
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")
  @moduletag timeout: 240_000
  @sync_app Path.expand("../../..", __DIR__)

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    connections = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :stateholder, Postgres)

    probe =
      System.get_env("CHALK_PRESENCE_MASTER_PROBE") ||
        Path.join(System.tmp_dir!(), "chalk-presence-probe-#{UUID.generate()}")

    on_exit(fn ->
      unless System.get_env("CHALK_PRESENCE_MASTER_PROBE"), do: File.rm(probe)
      Application.put_env(:chalk_sync, :stateholder, stateholder)
      restore_env(:database_connections, previous)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    unless System.get_env("CHALK_PRESENCE_MASTER_PROBE") do
      {output, status} =
        System.cmd("go", ["test", "-c", "-o", probe, "./internal/adapters/postgres"],
          cd: Path.expand("../../../../api", __DIR__),
          env: [{"GOTOOLCHAIN", System.get_env("CHALK_API_GOTOOLCHAIN", "go1.26.10+auto")}],
          stderr_to_stdout: true
        )

      assert status == 0, output
    end

    {:ok, connection: hd(connections), probe: probe}
  end

  setup %{connection: connection} do
    start_supervised!({PresenceRuntime, url: @database_url})
    allow_expiry(connection)

    policy = %{
      "linger_window_seconds" => 300,
      "artifact_policy" => %{
        "schema_version" => "episode_config.v2",
        "recording" => %{
          "mode" => "manual",
          "profile" => "composite_720p_v1",
          "retention_seconds" => 2_592_000
        },
        "transcription" => %{
          "mode" => "disabled",
          "retention_seconds" => 0,
          "source_window_seconds" => 0
        }
      }
    }

    fixture = SyncPostgres.seed_episode(connection, 2, policy)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    media =
      start_supervised!(%{
        id: MediaPlaneTestAdapter,
        start: {MediaPlaneTestAdapter, :start_link, [[]]}
      })

    recording =
      start_supervised!(%{
        id: RecordingPlaneTestAdapter,
        start: {RecordingPlaneTestAdapter, :start_link, [[]]}
      })

    {:ok, consumer} =
      ExternalOperationConsumer.start_link(
        poll_interval_ms: 10,
        page_size: 8,
        max_backoff_ms: 100,
        media_plane: {MediaPlaneTestAdapter, media},
        recording_plane: {RecordingPlaneTestAdapter, recording}
      )

    Process.unlink(consumer)
    on_exit(fn -> TestProcess.stop(consumer) end)
    {:ok, fixture: fixture, identity: hd(fixture.identities), media: media, recording: recording}
  end

  test "everyone drops: grace plus linger ends the Episode through normal capture stop", ctx do
    # The baseline runs the identical wire handshake against unmodified master Sync.
    node = if app = System.get_env("CHALK_PRESENCE_MASTER_SYNC_APP"), do: external_node(app)

    try do
      port = if node, do: ready_port(node), else: ctx.port
      client = connect(port, ctx.identity)
      recording_id = UUID.generate()

      operation =
        Operation.new("abandoned_recording_start", :start_recording, %{
          "recordingId" => recording_id
        })

      assert {:ok, _} = Postgres.begin_operation(ctx.identity, operation)
      assert eventually(fn -> recording_status(ctx, recording_id) == "recording" end)
      Client.close_tcp(client)
      before = attendance(ctx)
      # Inert metadata lets master reach the behavioral assertion, not a missing-table error.
      ensure_lease(ctx)
      allow_expiry(ctx.connection)
      expire(ctx, 1)
      assert tick(ctx) == 0
      assert attendance(ctx) == before
      assert episode_status(ctx) == "active"
      assert_no_leave(ctx)
      expire(ctx, 301)
      assert tick(ctx) == 1
      assert eventually(fn -> episode_status(ctx) == "ended" end)
      assert eventually(fn -> recording_status(ctx, recording_id) == "stopped" end)

      assert Enum.any?(RecordingPlaneTestAdapter.calls(ctx.recording), fn
               {:stop_recording, _, [_, ^recording_id]} -> true
               _ -> false
             end)

      assert tick(ctx) == 0
      assert_no_leave(ctx)
    after
      if node, do: ExternalSyncNode.stop(node)
    end
  end

  test "one drop changes no attendance, media, or Episode while another client pings", ctx do
    dropped = connect(ctx.port, ctx.identity)
    healthy = connect(ctx.port, Enum.at(ctx.fixture.identities, 1))
    Client.close_tcp(dropped)
    before = attendance(ctx)
    calls = MediaPlaneTestAdapter.calls(ctx.media)
    expire(ctx, 301)
    healthy = ping(healthy)
    assert lease_fresh?(ctx)
    assert tick(ctx) == 0
    assert attendance(ctx) == before
    assert MediaPlaneTestAdapter.calls(ctx.media) == calls
    assert episode_status(ctx) == "active"
    assert_no_leave(ctx)
    Client.close_tcp(healthy)
  end

  test "an abandoned unconfirmed replacement cannot strand the Episode", ctx do
    first = connect(ctx.port, ctx.identity)
    Client.close_tcp(first)

    {welcome, replacement} =
      hello(ctx.port, ctx.identity, "/v1/sync?entry_generation=new&entry_confirmation=1")

    replacement = recover(replacement, welcome)
    Client.close_tcp(replacement)

    Postgrex.query!(
      ctx.connection,
      "update participant_join_seats set issued_entry_expires_at=clock_timestamp()-interval '1 second' where participant_id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    [[issued, confirmed]] =
      Postgrex.query!(
        ctx.connection,
        "select issued_entry_generation,confirmed_entry_generation from participant_join_seats where participant_id=$1",
        [UUID.dump!(ctx.identity.participant_id)]
      ).rows

    assert issued > confirmed
    before = attendance(ctx)
    expire(ctx, 301)
    assert tick(ctx) == 1
    assert eventually(fn -> episode_status(ctx) == "ended" end)
    assert_no_leave(ctx)
    # Only the existing Episode-end finalizer may now change participants.
    assert Enum.all?(before, fn [_, _, status | _] -> status == "active" end)
  end

  test "a live connection on another Sync node cancels the empty window", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    node = external_node(@sync_app)

    try do
      port = ready_port(node)
      allow_expiry(ctx.connection)
      expire(ctx, 301)
      returned = connect(port, ctx.identity)
      returned = ping(returned)
      assert lease_fresh?(ctx)
      assert tick(ctx) == 0
      assert episode_status(ctx) == "active"
      assert_no_leave(ctx)
      Client.close_tcp(returned)
    after
      ExternalSyncNode.stop(node)
    end
  end

  for version <-
        if(System.get_env("CHALK_PRESENCE_PUBLISHED_ROOT"),
          do: ["head", "4.1.14", "5.0.0", "5.1.0", "5.2.0"],
          else: ["head"]
        ) do
    @tag sdk: version
    test "real SDK #{version} returns after grace and receives the existing ended reason", ctx do
      marker = Path.join(System.tmp_dir!(), "chalk-sdk-return-#{UUID.generate()}")

      on_exit(fn ->
        for suffix <- [".ready", ".expired", ".recovered", ".ended"],
            do: File.rm(marker <> suffix)
      end)

      script = Path.expand("../../fixtures/published-reconnect-probe.mjs", __DIR__)

      task =
        Task.async(fn ->
          System.cmd(
            "pnpm",
            ["exec", "tsx", script, ctx.sdk, to_string(ctx.port), token(ctx.identity), marker],
            cd: Path.expand("../../../../..", __DIR__),
            stderr_to_stdout: true
          )
        end)

      assert eventually(fn -> File.exists?(marker <> ".ready") end, 1000)
      before = attendance(ctx)
      expire(ctx, 1)
      assert tick(ctx) == 0
      assert attendance(ctx) == before
      assert_no_leave(ctx)
      File.write!(marker <> ".expired", "return")
      assert eventually(fn -> File.exists?(marker <> ".recovered") end, 1000)
      assert lease_fresh?(ctx)
      assert attendance(ctx) == before
      assert tick(ctx) == 0
      expire(ctx, 301)
      assert tick(ctx) == 1
      assert eventually(fn -> episode_status(ctx) == "ended" end)
      File.write!(marker <> ".ended", "return")
      {output, code} = Task.await(task, 35_000)
      IO.puts(output)
      assert code == 0, output
      assert_no_leave(ctx)
    end
  end

  # Long outages are an explicit acceptance run, not eight extra minutes in every CI run.
  if System.get_env("CHALK_SYNC_RESTART_PROOF") do
    for mode <- [:whole_runtime, :sync_only],
        seconds <- [2, 125],
        order <- [:api_first, :sync_first] do
      @tag restart_proof: true
      @tag outage_seconds: seconds, startup_order: order, outage_mode: mode
      test "#{mode} #{seconds}s outage, #{order}: reconnect gets a fresh grace", ctx do
        stop_supervised(PresenceRuntime)
        node = external_node(@sync_app)
        port = ready_port(node)
        client = connect(port, ctx.identity)
        Client.close_tcp(client)
        before = attendance(ctx)
        ExternalSyncNode.kill(node)
        expire(ctx, 301)
        allow_expiry(ctx.connection)
        assert eventually(fn -> not witness?(ctx) end)
        if ctx.outage_mode == :sync_only, do: assert(tick(ctx) == 0)
        Process.sleep(ctx.outage_seconds * 1000)
        if ctx.startup_order == :api_first, do: assert(tick(ctx) == 0)
        # A new supervised child starts a real application/runtime and its startup barrier.
        node = external_node(@sync_app)

        try do
          port = ready_port(node)

          assert [[true]] =
                   Postgrex.query!(
                     ctx.connection,
                     "select recover_after > clock_timestamp()+interval '110 seconds' from sync_presence_runtime",
                     []
                   ).rows

          assert tick(ctx) == 0
          returned = connect(port, ctx.identity)
          returned = ping(returned)
          allow_expiry(ctx.connection)
          assert lease_fresh?(ctx)
          assert tick(ctx) == 0
          assert attendance(ctx) == before
          assert episode_status(ctx) == "active"
          assert_no_leave(ctx)
          Client.close_tcp(returned)

          IO.puts(
            "RESTART_PROOF mode=#{ctx.outage_mode} seconds=#{ctx.outage_seconds} order=#{ctx.startup_order} recovered=same_identity"
          )
        after
          ExternalSyncNode.stop(node)
        end
      end
    end
  end

  defp ready_port(node) do
    assert {:ok, ready} = ExternalSyncNode.await_ready(node, 30_000)
    ready["port"]
  end

  defp external_node(app) do
    port = 20_000 + rem(System.unique_integer([:positive, :monotonic]), 10_000)
    {:ok, listener} = :gen_tcp.listen(port, [:binary, active: false])
    :ok = :gen_tcp.close(listener)

    start_supervised!(
      {ExternalSyncNode,
       app_dir: app, database_url: @database_url, port: port, node_id: "presence-#{port}"},
      id: {:sync_node, port}
    )
  end

  defp connect(port, identity) do
    {welcome, client} = hello(port, identity)
    assert welcome["mode"] != "terminal"
    recover(client, welcome)
  end

  defp recover(client, welcome) do
    client = Client.acknowledge_recovery(client, welcome)

    {:json, %{"type" => "recovery_complete"}, client} =
      recv_until(client, &match?({:json, %{"type" => "recovery_complete"}, _}, &1))

    client
  end

  defp hello(port, identity, path \\ "/v1/sync") do
    {:ok, client} = Client.connect(port, path)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    {welcome, client}
  end

  defp token(identity),
    do:
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "role" => identity.role,
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

  defp ping(client) do
    client = Client.send_json(client, %{"type" => "ping"})

    {:json, %{"type" => "pong"}, next} =
      recv_until(client, &match?({:json, %{"type" => "pong"}, _}, &1))

    next
  end

  defp recv_until(client, predicate, remaining \\ 32)
  defp recv_until(_client, _predicate, 0), do: flunk("expected wire frame not received")

  defp recv_until(client, predicate, remaining) do
    frame = Client.recv(client, 8_000)

    if predicate.(frame), do: frame, else: case(frame) do
      {:json, _, next} -> recv_until(next, predicate, remaining - 1)
      other -> flunk("unexpected wire result #{inspect(other)}")
    end
  end

  defp ensure_lease(ctx),
    do:
      Postgrex.query!(
        ctx.connection,
        "insert into episode_presence_leases (tenant_id,space_id,episode_id,expires_at) values ($1,$2,$3,clock_timestamp()) on conflict do nothing",
        scope(ctx)
      )

  defp expire(ctx, seconds),
    do:
      Postgrex.query!(
        ctx.connection,
        "update episode_presence_leases set expires_at=clock_timestamp()-make_interval(secs=>$4) where tenant_id=$1 and space_id=$2 and episode_id=$3",
        scope(ctx) ++ [seconds]
      )

  defp lease_fresh?(ctx),
    do:
      Postgrex.query!(
        ctx.connection,
        "select expires_at > clock_timestamp()+interval '110 seconds' from episode_presence_leases where tenant_id=$1 and space_id=$2 and episode_id=$3",
        scope(ctx)
      ).rows == [[true]]

  defp allow_expiry(connection),
    do:
      Postgrex.query!(
        connection,
        "update sync_presence_runtime set recover_after=clock_timestamp()-interval '1 hour' where singleton",
        []
      )

  defp witness?(ctx),
    do:
      Postgrex.query!(
        ctx.connection,
        "select exists(select 1 from pg_locks where locktype='advisory' and classid=1128811595 and objid=1 and objsubid=2 and granted)",
        []
      ).rows == [[true]]

  defp attendance(ctx),
    do:
      Postgrex.query!(
        ctx.connection,
        "select id,generation,status,joined_at,left_at,last_left_reason from participants where tenant_id=$1 and space_id=$2 and episode_id=$3 order by id",
        scope(ctx)
      ).rows

  defp episode_status(ctx) do
    [[status]] =
      Postgrex.query!(ctx.connection, "select status from episodes where id=$1", [
        UUID.dump!(ctx.fixture.episode.episode_id)
      ]).rows

    status
  end

  defp recording_status(ctx, id) do
    case Postgrex.query!(
           ctx.connection,
           "select status from sync_recordings where episode_id=$1 and recording_id=$2",
           [UUID.dump!(ctx.fixture.episode.episode_id), UUID.dump!(id)]
         ).rows do
      [[status]] -> status
      [] -> nil
    end
  end

  defp assert_no_leave(ctx) do
    assert [[0]] =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_external_operations where tenant_id=$1 and space_id=$2 and episode_id=$3 and operation_name in ('leave','participant_leave','remove_participant')",
               scope(ctx)
             ).rows

    assert [[0]] =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_control_events where tenant_id=$1 and space_id=$2 and episode_id=$3 and event_name='participant_left'",
               scope(ctx)
             ).rows
  end

  defp scope(ctx),
    do:
      Enum.map(
        [
          ctx.fixture.episode.tenant_id,
          ctx.fixture.episode.space_id,
          ctx.fixture.episode.episode_id
        ],
        &UUID.dump!/1
      )

  defp tick(ctx) do
    {output, code} =
      System.cmd(ctx.probe, ["-test.run=^TestDroppedPresenceLifecycleProbe$", "-test.v"],
        env: [{"CHALK_PRESENCE_PROBE_ACTION", "tick"}],
        stderr_to_stdout: true
      )

    assert code == 0, output
    line = output |> String.split("\n") |> Enum.find(&String.starts_with?(&1, "PRESENCE_PROBE="))
    assert is_binary(line), output
    line |> String.replace_prefix("PRESENCE_PROBE=", "") |> String.to_integer()
  end

  defp eventually(check, attempts \\ 200)
  defp eventually(check, 0), do: check.()

  defp eventually(check, attempts) do
    if check.(),
      do: true,
      else:
        (
          Process.sleep(20)
          eventually(check, attempts - 1)
        )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
