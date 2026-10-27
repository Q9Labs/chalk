defmodule ChalkSync.Transport.EndedReconnectPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
    previous_connections = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
      restore_connections(previous_connections)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    seed = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    {:ok, seed: seed}
  end

  test "a reconnect with the control cursor from before the end replays the final event", ctx do
    [identity | _] = ctx.seed.identities
    before_end = control_cursor(identity)
    end_episode(ctx.seed.episode)

    assert {%{"mode" => "replay"}, [%{"type" => "replay_page"} = page]} =
             reconnect(ctx.port, identity, before_end, true)

    assert [%{"name" => "episode_ended", "payload" => %{"reason" => "tenant_recovery"}}] =
             page["events"]
  end

  test "a reconnect already at the final head stays terminal when it asks for collaboration",
       ctx do
    [identity | _] = ctx.seed.identities
    end_episode(ctx.seed.episode)
    at_final_head = control_cursor(identity)

    for collaboration <- [false, true] do
      assert {%{"mode" => "terminal"}, []} =
               reconnect(ctx.port, identity, at_final_head, collaboration)
    end
  end

  @tag timeout: 110_000
  test "Sync and whiteboard sockets survive a 90 second client frame gap", ctx do
    [identity | _] = ctx.seed.identities
    {:ok, sync} = Client.connect(ctx.port, "/v1/sync")

    sync =
      Client.send_json(sync, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome"} = welcome, sync} = Client.recv(sync)
    sync = Client.acknowledge_recovery(sync, welcome)
    assert {:json, %{"type" => "recovery_complete"}, sync} = Client.recv(sync)
    assert {:json, %{"stream" => "media"}, sync} = Client.recv(sync)
    assert {:json, %{"stream" => "presence"}, sync} = Client.recv(sync)
    {:ok, whiteboard} = Client.connect(ctx.port, "/v1/whiteboard")

    whiteboard =
      Client.send_json(whiteboard, %{
        "type" => "hello",
        "protocol" => "whiteboard-v1",
        "token" => token(identity),
        "cursor" => nil
      })

    assert {:json, %{"type" => "welcome", "protocol" => "whiteboard-v1"}, whiteboard} =
             Client.recv(whiteboard)

    started = System.monotonic_time(:millisecond)
    Process.sleep(90_000)

    for client <- [sync, whiteboard] do
      assert {:ok, _projections, client} = Client.drain(client)
      client = Client.send_json(client, %{"type" => "ping"})
      assert {:json, %{"type" => "pong"}, client} = Client.recv(client)
      Client.close_tcp(client)
    end

    assert System.monotonic_time(:millisecond) - started >= 90_000
  end

  defp end_episode(episode) do
    {:ok, operation} = Operation.new("ended_reconnect_end", :tenant_end_episode, %{})
    {:ok, %{external_operation_id: id}} = Postgres.begin_internal_operation(episode, operation)

    {:ok, %{result: :applied}} =
      Postgres.finalize_operation(
        episode,
        id,
        {:applied, :episode_ended, %{"reason" => "tenant_recovery"}}
      )
  end

  defp control_cursor(identity) do
    {:ok, %{head: head}} = Postgres.recover(identity, nil)

    %{
      "revision" => head.revision,
      "state_schema_version" => head.state_schema_version,
      "state_digest" => Base.encode16(head.digest, case: :lower)
    }
  end

  defp reconnect(port, identity, cursor, collaboration) do
    {:ok, client} = Client.connect(port, "/v1/sync")

    streams =
      Map.new(["control", "media", "presence", "requests"], fn
        "control" -> {"control", %{"cursor" => cursor}}
        stream -> {stream, %{"cursor" => nil}}
      end)

    hello = %{
      "type" => "hello",
      "protocol" => 1,
      "token" => token(identity),
      "streams" => streams
    }

    hello =
      if collaboration,
        do:
          Map.put(hello, "extensions", [
            %{
              "name" => "collaboration_v1",
              "chat_cursor" => %{"after_sequence" => nil, "retained_floor_sequence" => nil}
            }
          ]),
        else: hello

    client = Client.send_json(client, hello)
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    {welcome, replay_pages(client)}
  end

  defp replay_pages(client) do
    case Client.recv(client, 500) do
      {:json, %{"type" => "replay_page"} = page, client} -> [page | replay_pages(client)]
      _closed_or_idle -> []
    end
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
        "role" => identity.role || "owner",
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

  defp restore_connections(nil), do: Application.delete_env(:chalk_sync, :database_connections)

  defp restore_connections(value),
    do: Application.put_env(:chalk_sync, :database_connections, value)
end
