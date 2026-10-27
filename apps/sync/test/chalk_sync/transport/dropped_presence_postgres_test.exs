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

      {:ok, operation} =
        Operation.new("abandoned_recording_start", :start_recording, %{
          "recordingId" => recording_id
        })

      assert {:ok, %{external_operation_id: start_id}} =
               Postgres.begin_operation(ctx.identity, operation)

      assert eventually(fn -> operation_status(ctx, start_id) == "applied" end)
      capture_ready(ctx, recording_id, start_id)
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

  test "expired dropped participant leaves while a healthy participant stays active", ctx do
    fixture =
      SyncPostgres.seed_webhook_endpoint(ctx.fixture, ctx.connection, ["participant.left"])

    ctx = %{ctx | fixture: fixture}
    dropped = connect(ctx.port, ctx.identity)
    healthy_identity = Enum.at(ctx.fixture.identities, 1)
    healthy = connect(ctx.port, healthy_identity)
    Client.close_tcp(dropped)

    assert tick(ctx) == 0
    assert_no_leave(ctx)

    expire_participant(ctx)
    healthy = ping(healthy)
    assert tick(ctx) == 1
    assert_expiry_evidence(ctx, "lease_expired", "last_seen_age_ms", 120_000)
    assert eventually(fn -> participant_status(ctx, ctx.identity) == "left" end)
    assert participant_status(ctx, healthy_identity) == "active"
    assert episode_status(ctx) == "active"
    assert tick(ctx) == 0

    [[joined_at, left_at, reason]] =
      Postgrex.query!(
        ctx.connection,
        "select joined_at,left_at,last_left_reason from participants where id=$1",
        [UUID.dump!(ctx.identity.participant_id)]
      ).rows

    assert DateTime.compare(left_at, joined_at) in [:gt, :eq]
    assert reason == "left"

    [[body, deliveries]] =
      Postgrex.query!(
        ctx.connection,
        "select e.body,(select count(*) from webhook_deliveries d where d.tenant_id=e.tenant_id and d.event_id=e.id) from webhook_events e where e.tenant_id=$1 and e.resource_id=$2 and e.event_name='participant.left'",
        [UUID.dump!(ctx.fixture.episode.tenant_id), UUID.dump!(ctx.identity.participant_id)]
      ).rows

    event = Jason.decode!(body)

    assert event["data"]["object"]["joined_at"] ==
             joined_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

    assert event["data"]["object"]["left_at"] ==
             left_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

    assert deliveries == 1
    Client.close_tcp(healthy)
  end

  test "a legacy joined participant without a first socket expires while the host stays", ctx do
    fixture =
      SyncPostgres.seed_webhook_endpoint(ctx.fixture, ctx.connection, ["participant.left"])

    ctx = %{ctx | fixture: fixture}
    healthy_identity = Enum.at(ctx.fixture.identities, 1)
    healthy = connect(ctx.port, healthy_identity)

    assert Postgrex.query!(
             ctx.connection,
             "select 1 from participant_presence_leases where participant_id=$1",
             [UUID.dump!(ctx.identity.participant_id)]
           ).rows == []

    assert tick(ctx) == 0

    Postgrex.query!(
      ctx.connection,
      "update participants set joined_at=clock_timestamp()-interval '150 seconds' where id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    assert tick(ctx) == 0
    assert participant_status(ctx, ctx.identity) == "active"

    Postgrex.query!(
      ctx.connection,
      "update participants set joined_at=clock_timestamp()-interval '601 seconds' where id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    Postgrex.query!(
      ctx.connection,
      "update sync_presence_runtime set recover_after=clock_timestamp()+interval '120 seconds' where singleton",
      []
    )

    assert tick(ctx) == 0
    allow_expiry(ctx.connection)
    healthy = ping(healthy)
    assert tick(ctx) == 1
    assert_expiry_evidence(ctx, "missing_lease", "joined_age_ms", 600_000)
    assert eventually(fn -> participant_status(ctx, ctx.identity) == "left" end)
    assert participant_status(ctx, healthy_identity) == "active"
    assert episode_status(ctx) == "active"

    {:json, %{"payload" => %{"participant_id" => participant_id}}, healthy} =
      recv_until(healthy, fn
        {:json, %{"type" => "event", "name" => "participant_left"}, _} -> true
        _ -> false
      end)

    assert participant_id == ctx.identity.participant_id

    [[left_at, body]] =
      Postgrex.query!(
        ctx.connection,
        "select p.left_at,e.body from participants p join webhook_events e on e.tenant_id=p.tenant_id and e.resource_id=p.id and e.event_name='participant.left' where p.id=$1",
        [UUID.dump!(ctx.identity.participant_id)]
      ).rows

    assert Jason.decode!(body)["data"]["object"]["left_at"] ==
             left_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

    assert tick(ctx) == 0
    Client.close_tcp(healthy)
  end

  test "a first socket cancels missing-lease expiry before the claim", ctx do
    Postgrex.query!(
      ctx.connection,
      "update participants set joined_at=clock_timestamp()-interval '601 seconds' where id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    first_socket = connect(ctx.port, ctx.identity)
    assert tick(ctx) == 0
    assert participant_status(ctx, ctx.identity) == "active"
    assert_no_leave(ctx)
    Client.close_tcp(first_socket)
  end

  test "reconnect before the expiry claim cancels participant departure", ctx do
    dropped = connect(ctx.port, ctx.identity)
    Client.close_tcp(dropped)
    expire_participant(ctx)
    reconnected = connect(ctx.port, ctx.identity)
    assert tick(ctx) == 0
    assert participant_status(ctx, ctx.identity) == "active"
    assert_no_leave(ctx)
    Client.close_tcp(reconnected)
  end

  defp assert_expiry_evidence(ctx, path, age_key, minimum_age_ms) do
    [[attributes]] =
      Postgrex.query!(
        ctx.connection,
        "select attributes from observability_journey_events where name='participant.connection_expired' and attributes->>'participant_id'=$1 order by occurred_at desc limit 1",
        [ctx.identity.participant_id]
      ).rows

    assert attributes["tenant_id"] == ctx.fixture.episode.tenant_id
    assert attributes["episode_id"] == ctx.fixture.episode.episode_id
    assert attributes["participant_id"] == ctx.identity.participant_id
    assert attributes["expiry_path"] == path
    assert String.to_integer(attributes[age_key]) >= minimum_age_ms
    if path == "missing_lease", do: refute(Map.has_key?(attributes, "last_seen_age_ms"))
  end

  defp expire_participant(ctx) do
    Postgrex.query!(
      ctx.connection,
      "update participant_presence_leases set expires_at=clock_timestamp()-interval '1 second' where participant_id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )
  end

  defp participant_status(ctx, identity) do
    [[status]] =
      Postgrex.query!(ctx.connection, "select status from participants where id=$1", [
        UUID.dump!(identity.participant_id)
      ]).rows

    status
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
          {output, code} =
            System.cmd(
              "pnpm",
              ["exec", "tsx", script, ctx.sdk, to_string(ctx.port), token(ctx.identity), marker],
              cd: Path.expand("../../../../..", __DIR__),
              stderr_to_stdout: true
            )

          IO.puts(output)
          {output, code}
        end)

      assert eventually(fn -> File.exists?(marker <> ".ready") end, 1000)
      before = attendance(ctx)
      # A three-minute drop: 120 seconds of grace, then 60 seconds of linger.
      expire(ctx, 60)
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
      assert code == 0, output
      assert_no_leave(ctx)
    end
  end

  # Long outages are an explicit acceptance run, not eight extra minutes in every CI run.
  if System.get_env("CHALK_SYNC_RESTART_PROOF") do
    defp witness?(ctx),
      do:
        Postgrex.query!(
          ctx.connection,
          "select exists(select 1 from pg_locks where locktype='advisory' and classid=1128811595 and objid=1 and objsubid=2 and granted)",
          []
        ).rows == [[true]]

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

        if ctx.outage_mode == :sync_only do
          assert tick(ctx) == 0
          # Keep the real API scheduler running while only Sync is down.
          for second <- 1..ctx.outage_seconds do
            Process.sleep(1_000)
            if rem(second, 5) == 0 or second == ctx.outage_seconds, do: assert(tick(ctx) == 0)
          end
        else
          Process.sleep(ctx.outage_seconds * 1000)
        end

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
    port = available_node_port(8)
    node_id = "presence-#{UUID.generate()}"

    start_supervised!(
      {ExternalSyncNode, app_dir: app, database_url: @database_url, port: port, node_id: node_id},
      id: {:sync_node, node_id}
    )
  end

  # Separate BEAMs have independent unique-integer counters. Avoid both their
  # deterministic collisions and the OS's outbound ephemeral-port range.
  defp available_node_port(attempts) do
    port = 19_999 + :rand.uniform(10_000)

    case :gen_tcp.listen(port, [:binary, active: false]) do
      {:ok, listener} ->
        :ok = :gen_tcp.close(listener)
        port

      {:error, :eaddrinuse} when attempts > 1 ->
        available_node_port(attempts - 1)

      error ->
        flunk("cannot allocate a Sync test port: #{inspect(error)}")
    end
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

    if predicate.(frame) do
      frame
    else
      case frame do
        {:json, _, next} -> recv_until(next, predicate, remaining - 1)
        other -> flunk("unexpected wire result #{inspect(other)}")
      end
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

  # Trusted capture-worker input; the production consumer/finalizer applies it.
  defp capture_ready(ctx, recording_id, start_id) do
    request = "abandoned_capture_ready"

    Postgrex.query!(
      ctx.connection,
      """
      insert into sync_external_operations (
        tenant_id,space_id,episode_id,external_operation_id,request_key,
        request_fingerprint,operation_name,recording_id,payload,fence_active
      ) values ($1,$2,$3,$4,$5,$6,'recording_capture_ready',$7,$8,false)
      """,
      scope(ctx) ++
        [
          UUID.dump!(UUID.generate()),
          request,
          :crypto.hash(:sha256, request),
          UUID.dump!(recording_id),
          %{"recordingId" => recording_id, "startOperationId" => start_id, "captureEpoch" => 1}
        ]
    )
  end

  defp operation_status(ctx, id) do
    [[status]] =
      Postgrex.query!(
        ctx.connection,
        "select status from sync_external_operations where external_operation_id=$1",
        [UUID.dump!(id)]
      ).rows

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
