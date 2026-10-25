defmodule ChalkSync.Transport.DroppedPresencePostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
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
    {:ok, connection: hd(connections), probe: probe}
  end

  setup %{connection: connection} do
    fixture = SyncPostgres.seed_episode(connection, 1, %{"linger_window_seconds" => 300})
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Postgrex.query!(connection,
      "update episodes set config_snapshot=jsonb_set(config_snapshot,'{linger_window_seconds}','300') where id=$1",
      [UUID.dump!(fixture.episode.episode_id)])
    {:ok, media_plane} = MediaPlaneTestAdapter.start_link(outcomes: %{})

    start_supervised!(
      {ExternalOperationConsumer,
       poll_interval_ms: 10,
       page_size: 8,
       max_backoff_ms: 100,
       media_plane: {MediaPlaneTestAdapter, media_plane}}
    )

    {:ok, fixture: fixture, identity: hd(fixture.identities)}
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

    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, {_address, port}} = :inet.sockname(listener)
    :ok = :gen_tcp.close(listener)

    node =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: Path.expand("../../..", __DIR__),
         database_url: @database_url,
         port: port,
         node_id: "dropped-presence"}
      )

    assert {:ok, _ready} = ExternalSyncNode.await_ready(node, 30_000)
    returned = connect(port, ctx.identity)
    on_exit(fn -> Client.close_tcp(returned) end)

    assert [[true]] =
             Postgrex.query!(
               ctx.connection,
               "select expires_at > clock_timestamp()+interval '110 seconds' from participant_presence_leases where participant_id=$1",
               [UUID.dump!(ctx.identity.participant_id)]
             ).rows

    assert probe(ctx, "tick") == 0
    assert status(ctx) == "active"
  end

  test "a return after grace uses normal admission and old cleanup cannot evict it", ctx do
    client = connect(ctx.port, ctx.identity)
    Client.close_tcp(client)
    expire(ctx)
    assert probe(ctx, "tick") == 1
    assert eventually(fn -> status(ctx) == "left" end)
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

  defp connect(port, identity) do
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
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client
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
