defmodule ChalkSync.Transport.SocketV1Test do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.TestWSClient, as: Client

  test "wire events correlate edge headers with verified hello identity", %{port: port} do
    owner = self()
    handler = "connect-diagnostics-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event in [
             "sync.websocket.handshake",
             "sync.websocket.authenticated",
             "sync.websocket.closed"
           ],
           do: send(owner, {:socket_event, metadata.event, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    host = identity()
    seed_participants(host, [host])

    client =
      connect_live(port, host, [
        {"cf-connecting-ip", "192.0.2.10"},
        {"user-agent", "Windows Chrome fixture"},
        {"authorization", "Bearer do-not-log"}
      ])

    assert_receive {:socket_event, "sync.websocket.handshake", connected}
    assert connected.client_ip == "192.0.2.10"
    assert connected.user_agent == "Windows Chrome fixture"
    assert Map.has_key?(connected, :close_code)
    refute Map.has_key?(connected, :tenant_id)
    assert_receive {:socket_event, "sync.websocket.authenticated", authenticated}
    assert authenticated.tenant_id == host.episode.tenant_id
    assert authenticated.episode_id == host.episode.episode_id
    assert authenticated.participant_id == host.participant_id
    refute inspect(authenticated) =~ "do-not-log"
    client = Client.close(client)
    Client.recv(client)
    assert_receive {:socket_event, "sync.websocket.closed", closed}
    assert closed.client_ip == connected.client_ip
    assert closed.user_agent == connected.user_agent
    assert closed.tenant_id == authenticated.tenant_id
    assert closed.participant_id == authenticated.participant_id
    assert closed.episode_id == authenticated.episode_id
    assert Map.has_key?(closed, :close_code)
  end

  test "a failure after authentication keeps the identity on close", %{port: port} do
    owner = self()
    handler = "failed-hello-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:failed_hello, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    host = identity()
    seed_participants(host, [host])
    rejected = %{host | admission_lifecycle_intent_id: ChalkSync.UUID.generate()}
    {:ok, client} = Client.connect(port)
    client = Client.send_json(client, hello(rejected, %{}))
    assert {:closed, 1012, _reason, _client} = Client.recv(client)
    assert_receive {:failed_hello, closed}
    assert closed.tenant_id == host.episode.tenant_id
    assert closed.participant_id == host.participant_id
    assert closed.episode_id == host.episode.episode_id
    assert closed.close_code == 1012
  end

  test "durable commands emit ACKs and events and preserve idempotency", %{port: port} do
    host = identity()
    seed_participants(host, [host])
    client = connect_live(port, host)

    {client, hand_ack} =
      command(client, "v1-command-hand-0001", "set_hand_raised", %{"raised" => true})

    assert hand_ack["outcome"] == "committed"

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v1-command-hand-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "delivery" => "duplicate"} = duplicate, client} =
             Client.recv(client)

    assert duplicate["event_id"] == hand_ack["event_id"]

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v1-command-hand-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => false}
      })

    assert {:json, %{"type" => "ack", "outcome" => "command_id_conflict"}, _client} =
             Client.recv(client)
  end

  test "rejects a command from a participant without the capability", %{port: port} do
    host = identity()
    guest = %{identity() | episode: host.episode, role: "observer", capabilities: ["subscribe"]}
    seed_participants(host, [host, guest])
    client = connect_live(port, guest)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v1-command-authorization-0001",
        "name" => "set_admission_policy",
        "payload" => %{"policy" => "knock"}
      })

    assert {:json, %{"type" => "ack", "outcome" => "rejected"}, _client} =
             Client.recv(client)
  end

  test "real class sockets distinguish thirteen normal leaves from twelve TCP drops", %{
    port: port
  } do
    handler = "wire-close-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:wire_closed, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    host = identity()
    participants = for _ <- 1..13, do: %{identity() | episode: host.episode}
    seed_participants(host, participants)
    clients = Enum.map(participants, &connect_live(port, &1))
    on_exit(fn -> Enum.each(clients, &Client.close_tcp/1) end)

    Enum.each(clients, fn client ->
      Client.close(client)
      assert_receive {:wire_closed, %{reason: :client_closed, close_kind: :normal}}, 2_000
    end)

    # Repeat against the real TCP/upgrade transport, not just callback inputs.
    dropped = Enum.map(Enum.take(participants, 12), &connect_live(port, &1))
    on_exit(fn -> Enum.each(dropped, &Client.close_tcp/1) end)

    Enum.each(dropped, fn client ->
      Client.close_tcp(client)
      assert_receive {:wire_closed, %{reason: :transport_error, close_kind: :abnormal}}, 2_000
    end)
  end

  test "published up-to-date acknowledgements are optional and exactly fenced", %{port: port} do
    for {timing, invalid} <- [
          {:before_complete, "recovery_id"},
          {:after_complete, "revision"},
          {:after_complete, "state_digest"}
        ] do
      host = identity()
      seed_participants(host, [host])
      first = connect_live(port, host)
      {:ok, recovery} = Memory.recover(host.episode, nil)

      cursor = %{
        "revision" => recovery.head.revision,
        "state_schema_version" => recovery.head.state_schema_version,
        "state_digest" => Base.encode16(recovery.head.digest, case: :lower)
      }

      Client.close_tcp(first)
      {:ok, returned} = Client.connect(port, "/v1/sync")

      returned =
        Client.send_json(
          returned,
          put_in(hello(host, %{}), ["streams", "control", "cursor"], cursor)
        )

      assert {:json, %{"mode" => "up_to_date"} = welcome, returned} = Client.recv(returned)

      ack = %{
        "type" => "recovery_ack",
        "recovery_id" => welcome["recovery_id"],
        "revision" => cursor["revision"],
        "state_digest" => cursor["state_digest"]
      }

      returned =
        if timing == :before_complete, do: Client.send_json(returned, ack), else: returned

      returned =
        Enum.reduce(1..3, returned, fn _, client ->
          assert {:json, _, next} = Client.recv(client)
          next
        end)

      returned = if timing == :after_complete, do: Client.send_json(returned, ack), else: returned
      returned = Client.send_json(returned, %{"type" => "ping"})
      assert {:json, %{"type" => "pong"}, returned} = Client.recv(returned)

      wrong =
        case invalid do
          "recovery_id" -> ChalkSync.UUID.generate()
          "revision" -> cursor["revision"] + 1
          "state_digest" -> String.duplicate("0", 64)
        end

      returned = Client.send_json(returned, Map.put(ack, invalid, wrong))
      assert {:closed, 1002, _, _} = Client.recv(returned)
    end
  end

  defp hello(identity, correlation) do
    token =
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

    frame = %{
      "type" => "hello",
      "protocol" => 1,
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }

    Map.merge(frame, correlation)
  end

  defp connect_live(port, identity, headers \\ [], correlation \\ %{}) do
    {:ok, client} = Client.connect(port, "/v1/sync", headers)
    client = Client.send_json(client, hello(identity, correlation))
    {:json, %{"type" => "welcome", "protocol" => 1} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} =
      Client.recv(client)

    {:json,
     %{
       "type" => "projection_snapshot",
       "stream" => "presence",
       "items" => presence
     }, client} = Client.recv(client)

    assert Enum.any?(presence, &(&1["participant_id"] == identity.participant_id))
    client
  end

  defp seed_participants(owner, participants) do
    assert :ok =
             Memory.seed_episode(
               owner.episode,
               Enum.map(participants, fn identity ->
                 %{
                   id: identity.participant_id,
                   generation: identity.participant_generation,
                   display_name: "Participant",
                   role: identity.role || "owner",
                   capabilities: identity.capabilities,
                   admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
                 }
               end)
             )

    Enum.each(participants, fn identity ->
      assert {:ok, %{result: :already_applied}} =
               Memory.apply_lifecycle_intent(
                 identity.episode,
                 identity.admission_lifecycle_intent_id
               )
    end)
  end

  defp command(client, command_id, name, payload) do
    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => command_id,
        "name" => name,
        "payload" => payload
      })

    {:json, %{"type" => "ack", "outcome" => "committed"} = ack, client} =
      Client.recv(client)

    {:json, %{"type" => "event", "command_id" => ^command_id}, client} = Client.recv(client)
    {client, ack}
  end

  defp identity do
    suffix = System.unique_integer([:positive, :monotonic])

    %Identity{
      episode: %EpisodeKey{
        tenant_id: uuid(suffix),
        space_id: uuid(suffix + 1),
        episode_id: uuid(suffix + 2)
      },
      participant_id: uuid(suffix + 3),
      participant_generation: 1,
      admission_lifecycle_intent_id: uuid(suffix + 4),
      role: "owner",
      capabilities: [
        "publishAudio",
        "publishVideo",
        "publishScreen",
        "subscribe",
        "raiseHand",
        "renameSelf",
        "sendChat",
        "sendReaction",
        "drawWhiteboard",
        "manageWhiteboard",
        "manageAdmission",
        "assignRoles",
        "muteOthers",
        "stopVideoOthers",
        "stopScreenOthers",
        "requestMediaOthers",
        "removeParticipant",
        "manageRecording",
        "startEpisode",
        "extendEpisode",
        "endEpisode",
        "manageMembers",
        "clearSpaceContent"
      ]
    }
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")
    "018f2f65-2a77-4a44-8e9a-#{suffix}"
  end
end
