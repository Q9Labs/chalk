defmodule ChalkSync.Transport.DroppedPresencePostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.PresenceRuntime
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")
  @moduletag timeout: 120_000

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    connections = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    probe = Path.join(System.tmp_dir!(), "chalk-presence-probe-#{UUID.generate()}")

    on_exit(fn ->
      File.rm(probe)
      Application.put_env(:chalk_sync, :stateholder, stateholder)
      restore_env(:database_connections, previous)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    {output, status} =
      System.cmd("go", ["test", "-c", "-o", probe, "./internal/adapters/postgres"],
        cd: Path.expand("../../../../api", __DIR__),
        env: [{"GOTOOLCHAIN", System.get_env("CHALK_API_GOTOOLCHAIN", "go1.26.10+auto")}],
        stderr_to_stdout: true
      )

    assert status == 0, output
    old_root = Path.join(System.tmp_dir!(), "chalk-pre-presence-#{UUID.generate()}")
    File.mkdir_p!(old_root)
    on_exit(fn -> File.rm_rf!(old_root) end)
    archive = File.read!(Path.expand("../../fixtures/pre-presence/source.tar.gz", __DIR__))

    assert Base.encode16(:crypto.hash(:sha256, archive), case: :lower) ==
             "d7ba6b2df9c5193d0675f0c96b4612f2c5c1a6172e0fe6dd733491c8fd44bc36"

    :ok =
      :erl_tar.extract({:binary, archive}, [:compressed, {:cwd, String.to_charlist(old_root)}])

    old_app = Path.join(old_root, "apps/sync")

    for args <- [["deps.get", "--check-locked"], ["compile"]] do
      {output, code} =
        System.cmd("mix", args, cd: old_app, env: [{"MIX_ENV", "test"}], stderr_to_stdout: true)

      assert code == 0, output
    end

    {:ok, connection: hd(connections), probe: probe, old_app: old_app}
  end

  setup %{connection: connection} do
    start_supervised!({PresenceRuntime, url: @database_url})
    allow_expiry(connection)
    fixture = SyncPostgres.seed_episode(connection, 1, %{"linger_window_seconds" => 300})
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    media_plane =
      start_supervised!(%{
        id: MediaPlaneTestAdapter,
        start: {MediaPlaneTestAdapter, :start_link, [[outcomes: %{}]]}
      })

    {:ok, consumer} =
      ExternalOperationConsumer.start_link(
        poll_interval_ms: 10,
        page_size: 8,
        max_backoff_ms: 100,
        media_plane: {MediaPlaneTestAdapter, media_plane}
      )

    Process.unlink(consumer)
    on_exit(fn -> TestProcess.stop(consumer) end)

    {:ok, fixture: fixture, identity: hd(fixture.identities), media_plane: media_plane}
  end

  test "a dropped socket leaves after grace and the empty Episode ends after linger", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "left" end)
    assert probe(ctx, "tick") == 0
    assert episode_status(ctx) == "active"

    Postgrex.query!(
      ctx.connection,
      "update participants set left_at=clock_timestamp()-interval '301 seconds' where id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    assert probe(ctx, "tick") == 1
    assert eventually(fn -> episode_status(ctx) == "ended" end)
    assert probe(ctx, "tick") == 0
  end

  test "a return on another Sync node renews shared presence before grace expires", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)

    Postgrex.query!(
      ctx.connection,
      "update participant_presence_leases set expires_at=clock_timestamp()+interval '90 seconds' where participant_id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    node = external_node(Path.expand("../../..", __DIR__))

    try do
      assert {:ok, ready} = ExternalSyncNode.await_ready(node, 30_000)
      returned = connect(ready["port"], ctx.identity)
      on_exit(fn -> Client.close_tcp(returned) end)

      assert [[true]] =
               Postgrex.query!(
                 ctx.connection,
                 "select expires_at > clock_timestamp()+interval '110 seconds' from participant_presence_leases where participant_id=$1",
                 [UUID.dump!(ctx.identity.participant_id)]
               ).rows

      assert probe(ctx, "tick") == 0
      assert status(ctx) == "active"
    after
      ExternalSyncNode.stop(node)
    end
  end

  test "a return after grace uses normal admission and old cleanup cannot evict it", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "left" end)
    {welcome, expired} = hello(ctx.port, ctx.identity)
    assert welcome["mode"] == "terminal"
    assert welcome["reason"] == "presence_expired"
    Client.close_tcp(expired)
    admission = probe(ctx, "rejoin")

    identity = %{
      ctx.identity
      | participant_id: admission["participant_id"],
        participant_generation: admission["generation"],
        admission_lifecycle_intent_id: admission["intent_id"]
    }

    returned = connect(ctx.port, identity)
    on_exit(fn -> Client.close_tcp(returned) end)
    assert status(%{ctx | identity: identity}) == "active"
    assert probe(ctx, "tick") == 0
    assert episode_status(ctx) == "active"
    assert status(ctx) == "left"
  end

  test "healthy client heartbeats renew the lease without another entry", ctx do
    client = connect(ctx.port, ctx.identity)

    Postgrex.query!(
      ctx.connection,
      "update participant_presence_leases set expires_at=clock_timestamp()+interval '90 seconds' where participant_id=$1",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    client =
      Enum.reduce(1..21, client, fn _index, socket ->
        socket = Client.send_json(socket, %{"type" => "ping"})
        Process.sleep(1_000)
        socket
      end)

    Client.close_tcp(client)

    assert [[true]] =
             Postgrex.query!(
               ctx.connection,
               "select expires_at > clock_timestamp()+interval '110 seconds' from participant_presence_leases where participant_id=$1",
               [UUID.dump!(ctx.identity.participant_id)]
             ).rows

    assert probe(ctx, "tick") == 0
    assert status(ctx) == "active"
  end

  test "a failed provider removal leaves a retryable presence window", ctx do
    MediaPlaneTestAdapter.put_outcome(
      ctx.media_plane,
      :remove_participant,
      {:terminal_failure, :provider_unavailable}
    )

    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "active" end)
    MediaPlaneTestAdapter.put_outcome(ctx.media_plane, :remove_participant, :confirmed)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "left" end)
  end

  test "a healthy return from new Sync to old Sync cannot be evicted by its prior lease", ctx do
    first = connect(ctx.port, ctx.identity)
    Client.close_tcp(first)
    node = external_node(ctx.old_app)

    try do
      assert {:ok, ready} = ExternalSyncNode.await_ready(node, 30_000)
      client = connect(ready["port"], ctx.identity)
      client = Client.send_json(client, %{"type" => "ping"})
      client = await_pong(client)
      expire(ctx)
      assert probe(ctx, "tick") == 0
      assert status(ctx) == "active"
      client = Client.send_json(client, %{"type" => "ping"})
      client = await_pong(client)
      Client.close_tcp(client)
    after
      ExternalSyncNode.stop(node)
    end
  end

  test "compatibility rollout cannot expire a lease left by an earlier fenced entry", ctx do
    first = connect(ctx.port, ctx.identity)
    Client.close_tcp(first)
    expire(ctx)

    Postgrex.query!(
      ctx.connection,
      "update sync_entry_rollout set enforced=false, enforced_at=null, release_id=null where singleton",
      []
    )

    on_exit(fn ->
      Postgrex.query!(
        ctx.connection,
        "update sync_entry_rollout set enforced=true, enforced_at=clock_timestamp(), release_id='test' where singleton",
        []
      )
    end)

    returned = connect(ctx.port, ctx.identity)
    on_exit(fn -> Client.close_tcp(returned) end)
    assert probe(ctx, "tick") == 0
    assert status(ctx) == "active"

    Postgrex.query!(
      ctx.connection,
      "update sync_entry_rollout set enforced=true, enforced_at=clock_timestamp(), release_id='test' where singleton",
      []
    )

    assert probe(ctx, "tick") == 0
    assert status(ctx) == "active"
    returned = returned |> Client.send_json(%{"type" => "ping"}) |> await_pong()
    Client.close_tcp(returned)
  end

  test "judge: two API instances and repeated expiry reserve one Leave", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    expire(ctx)

    counts =
      1..2 |> Task.async_stream(fn _ -> probe(ctx, "tick") end) |> Enum.map(fn {:ok, n} -> n end)

    assert Enum.sum(counts) == 1
    assert eventually(fn -> status(ctx) == "left" end)
    assert probe(ctx, "tick") == 0

    assert [[1]] =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_external_operations where target_participant_id=$1 and operation_name='participant_leave'",
               [UUID.dump!(ctx.identity.participant_id)]
             ).rows
  end

  test "judge: one dropped participant cannot end a still-occupied Episode", ctx do
    fixture = SyncPostgres.seed_episode(ctx.connection, 2, %{"linger_window_seconds" => 0})
    on_exit(fn -> SyncPostgres.cleanup(ctx.connection, fixture.episode) end)
    [first, second] = fixture.identities
    ctx = %{ctx | fixture: fixture, identity: first}
    dropped = connect(ctx.port, first)
    kept = connect(ctx.port, second)
    on_exit(fn -> Client.close_tcp(kept) end)
    Client.close_tcp(dropped)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "left" end)
    assert probe(ctx, "tick") == 0
    assert episode_status(ctx) == "active"

    assert [["active"]] =
             Postgrex.query!(ctx.connection, "select status from participants where id=$1", [
               UUID.dump!(second.participant_id)
             ]).rows

    assert [[0]] =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_external_operations where episode_id=$1 and operation_name in ('stop_recording','end_episode','tenant_end_episode')",
               [UUID.dump!(fixture.episode.episode_id)]
             ).rows
  end

  test "judge: a renewal blocked by Postgres closes the live socket instead of silent expiry",
       ctx do
    client = connect(ctx.port, ctx.identity)
    coordinator = Coordinator.whereis(ctx.identity.episode)
    [socket] = :sys.get_state(coordinator).sockets |> Map.keys()
    [lock_connection] = SyncPostgres.start_connections(@database_url, 1)
    Process.unlink(lock_connection)
    on_exit(fn -> TestProcess.stop(lock_connection) end)
    Postgrex.query!(lock_connection, "begin", [])

    Postgrex.query!(
      lock_connection,
      "lock table participant_presence_leases in access exclusive mode",
      []
    )

    try do
      send(socket, :heartbeat_check)

      assert {:closed, 1012, "presence recovery required", _client} =
               judge_recv_until(client, fn frame -> match?({:closed, _, _, _}, frame) end)
    after
      Postgrex.query!(lock_connection, "rollback", [])
    end

    assert probe(ctx, "tick") == 0
    assert status(ctx) == "active"
  end

  test "judge: old Sync with new API and no prior lease stays active", ctx do
    node = external_node(ctx.old_app)

    try do
      client =
        connect(
          ExternalSyncNode.await_ready(node, 30_000) |> elem(1) |> Map.fetch!("port"),
          ctx.identity
        )

      on_exit(fn -> Client.close_tcp(client) end)

      assert [[0]] =
               Postgrex.query!(
                 ctx.connection,
                 "select count(*) from participant_presence_leases where participant_id=$1",
                 [UUID.dump!(ctx.identity.participant_id)]
               ).rows

      assert probe(ctx, "tick") == 0
      assert status(ctx) == "active"
    after
      ExternalSyncNode.stop(node)
    end
  end

  for shutdown <- [:stop, :kill] do
    @tag shutdown: shutdown
    test "#{shutdown} of Sync gives existing participants fresh grace after any downtime", ctx do
      stop_supervised!(PresenceRuntime)
      node = external_node(Path.expand("../../..", __DIR__))
      assert {:ok, ready} = ExternalSyncNode.await_ready(node, 30_000)
      first = connect(ready["port"], ctx.identity)
      apply(ExternalSyncNode, ctx.shutdown, [node])
      Client.close_tcp(first)

      # Simulate a downtime longer than any configured grace, with the API
      # scheduler restarting independently (the probe is a fresh API process).
      expire(ctx)
      allow_expiry(ctx.connection)
      assert probe(ctx, "tick") == 0
      assert status(ctx) == "active"

      replacement = external_node(Path.expand("../../..", __DIR__))

      try do
        assert {:ok, ready} = ExternalSyncNode.await_ready(replacement, 30_000)

        assert [[true]] =
                 Postgrex.query!(
                   ctx.connection,
                   "select recover_after > clock_timestamp()+interval '110 seconds' from participant_presence_runtime",
                   []
                 ).rows

        assert probe(ctx, "tick") == 0
        assert status(ctx) == "active"
        returned = connect(ready["port"], ctx.identity)
        assert status(ctx) == "active"
        allow_expiry(ctx.connection)
        assert probe(ctx, "tick") == 0
        Client.close_tcp(returned)
        expire(ctx)
        # The replacement's production consumer can claim this Leave without a
        # media adapter. Provider completion is covered by the drop/linger test.
        assert probe(ctx, "tick") == 1
      after
        ExternalSyncNode.stop(replacement)
      end
    end
  end

  defp allow_expiry(connection) do
    Postgrex.query!(
      connection,
      "update participant_presence_runtime set recover_after=clock_timestamp()-interval '1 hour' where singleton",
      []
    )
  end

  defp judge_recv_until(client, predicate, remaining \\ 16)

  defp judge_recv_until(_client, _predicate, 0),
    do: flunk("expected wire frame not received within 16 frames")

  defp judge_recv_until(client, predicate, remaining) do
    frame = Client.recv(client, 8_000)

    if predicate.(frame) do
      frame
    else
      case frame do
        {:json, _payload, next} -> judge_recv_until(next, predicate, remaining - 1)
        other -> flunk("unexpected wire result #{inspect(other)}")
      end
    end
  end

  defp await_pong(client) do
    case Client.recv(client) do
      {:json, %{"type" => "pong"}, client} -> client
      {:json, %{"type" => "projection_snapshot"}, client} -> await_pong(client)
      other -> flunk("expected pong, got #{inspect(other)}")
    end
  end

  defp external_node(app) do
    # Do not hand a soon-to-start server a port from the outbound client range.
    # Other test sockets can claim an ephemeral port before the child binds it.
    port = 20_000 + rem(System.unique_integer([:positive, :monotonic]), 10_000)
    {:ok, listener} = :gen_tcp.listen(port, [:binary, active: false])
    {:ok, {_address, port}} = :inet.sockname(listener)
    :ok = :gen_tcp.close(listener)

    start_supervised!(
      {ExternalSyncNode,
       app_dir: app, database_url: @database_url, port: port, node_id: "presence-#{port}"}
    )
  end

  defp connect(port, identity) do
    {welcome, client} = hello(port, identity)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client
  end

  defp hello(port, identity) do
    {:ok, client} = Client.connect(port, "/v1/sync")

    token =
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

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token,
        "streams" => %{
          "control" => %{"cursor" => nil},
          "media" => %{"cursor" => nil},
          "presence" => %{"cursor" => nil},
          "requests" => %{"cursor" => nil}
        }
      })

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    {welcome, client}
  end

  defp expire(ctx) do
    assert %{num_rows: 1} =
             Postgrex.query!(
               ctx.connection,
               "update participant_presence_leases set expires_at=clock_timestamp()-interval '1 second' where participant_id=$1",
               [UUID.dump!(ctx.identity.participant_id)]
             )
  end

  defp status(ctx) do
    [[status]] =
      Postgrex.query!(ctx.connection, "select status from participants where id=$1", [
        UUID.dump!(ctx.identity.participant_id)
      ]).rows

    status
  end

  defp episode_status(ctx) do
    [[status]] =
      Postgrex.query!(ctx.connection, "select status from episodes where id=$1", [
        UUID.dump!(ctx.fixture.episode.episode_id)
      ]).rows

    status
  end

  defp probe(ctx, action) do
    {output, status} =
      System.cmd(ctx.probe, ["-test.run=^TestDroppedPresenceLifecycleProbe$", "-test.v"],
        env: [
          {"CHALK_PRESENCE_PROBE_ACTION", action},
          {"CHALK_PRESENCE_TENANT", ctx.fixture.episode.tenant_id},
          {"CHALK_PRESENCE_SPACE", ctx.fixture.episode.space_id},
          {"CHALK_PRESENCE_EPISODE", ctx.fixture.episode.episode_id}
        ],
        stderr_to_stdout: true
      )

    assert status == 0, output
    line = output |> String.split("\n") |> Enum.find(&String.starts_with?(&1, "PRESENCE_PROBE="))
    assert is_binary(line), output
    line |> String.replace_prefix("PRESENCE_PROBE=", "") |> JSON.decode!()
  end

  defp eventually(check, attempts \\ 100)
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
