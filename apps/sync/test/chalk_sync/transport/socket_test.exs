defmodule ChalkSync.Transport.SocketV1Test do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.TestWSClient, as: Client

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
