defmodule ChalkSync.Transport.SocketV1Test do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.TestWSClient, as: Client

  defmodule BlockingMediaPlane do
    @moduledoc false

    @behaviour ChalkSync.MediaPlane

    @impl true
    def observe_episode_publications(controller, _episode) do
      send(controller, :blocking_media_observation_started)
      Process.sleep(:infinity)
    end

    @impl true
    def grant_publication(_adapter, _operation_id, _episode, _participant_id, _source),
      do: :confirmed

    @impl true
    def revoke_publication(_adapter, _operation_id, _episode, _participant_id, _source),
      do: :confirmed

    @impl true
    def remove_participant(_adapter, _operation_id, _episode, _participant_id), do: :confirmed

    @impl true
    def end_episode(_adapter, _operation_id, _episode), do: :confirmed
  end

  defmodule DropCommandResultGate do
    @moduledoc false

    @behaviour ChalkSync.DeliveryGate

    @impl true
    def decide(_checkpoint, _metadata), do: :deliver

    @impl true
    def emit(:command_result, _metadata, _recipient, _message), do: :ok

    @impl true
    def emit(_checkpoint, _metadata, recipient, message) do
      send(recipient, message)
      :ok
    end
  end

  defmodule CollaborationRepository do
    @moduledoc false
    @behaviour ChalkSync.Chat.Repository

    @message %{
      message_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c81",
      client_message_id: "chat-message-0001",
      sequence: "1",
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      display_name: "Ada",
      text: "Hello from Chalk",
      attachments: [],
      created_at: "2026-07-29T14:00:00.000Z"
    }

    @impl true
    def authorize(_identity, _capability), do: {:ok, %{display_name: "Ada"}}

    @impl true
    def participant_capabilities(identity) do
      {:ok,
       %{
         capabilities: ["sendReaction", "sendChat"],
         participant_capabilities: %{
           identity.participant_id => ["sendReaction", "sendChat"]
         }
       }}
    end

    @impl true
    def append(identity, input) do
      attachments =
        if Map.get(input, :attachment_ids, []) == [] do
          []
        else
          [
            %{
              attachment_id: hd(input.attachment_ids),
              file_name: "diagram.png",
              mime_type: "image/png",
              byte_length: 32
            }
          ]
        end

      {:ok,
       %{
         outcome: :committed,
         message: %{
           @message
           | participant_id: identity.participant_id,
             client_message_id: input.client_message_id,
             text: input.text,
             attachments: attachments
         }
       }}
    end

    @impl true
    def head(_episode), do: {:ok, %{head_sequence: "1", retained_floor_sequence: "1"}}

    @impl true
    def read_receipts(_episode), do: {:ok, []}

    @impl true
    def mark_read(identity, "1") do
      {:ok,
       %{
         outcome: :advanced,
         receipt: %{
           participant_id: identity.participant_id,
           participant_generation: identity.participant_generation,
           sequence: "1",
           read_at: "2026-07-29T14:01:00.000Z"
         }
       }}
    end

    @impl true
    def read_page(_episode, _request) do
      {:ok,
       %{
         messages: [@message],
         has_more: false,
         head_sequence: "1",
         retained_floor_sequence: "1"
       }}
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :media_plane)

    previous_chat_repository = Application.get_env(:chalk_sync, :chat_repository)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    Application.put_env(
      :chalk_sync,
      :chat_repository,
      CollaborationRepository
    )

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)

      if previous_chat_repository,
        do:
          Application.put_env(
            :chalk_sync,
            :chat_repository,
            previous_chat_repository
          ),
        else: Application.delete_env(:chalk_sync, :chat_repository)
    end)

    {:ok, adapter: adapter}
  end

  test "all five v1 durable commands use exact ACKs and event delivery", %{port: port} do
    host = identity()
    guest = %{identity() | episode: host.episode}
    seed_participants(host, [host, guest])
    client = connect_live(port, host)

    {client, hand_ack} =
      command(client, "v1-command-hand-0001", "set_hand_raised", %{"raised" => true})

    assert hand_ack["outcome"] == "committed"

    {client, _display_ack} =
      command(client, "v1-command-name-0001", "set_display_name", %{
        "display_name" => "Ada Lovelace"
      })

    {client, _policy_ack} =
      command(client, "v1-command-policy-01", "set_admission_policy", %{
        "policy" => "knock"
      })

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v1-command-reject-01",
        "name" => "assign_roles",
        "payload" => %{
          "participant_id" => "00000000-0000-4000-8000-000000000099",
          "role" => "observer"
        }
      })

    assert {:json, %{"type" => "ack", "outcome" => "rejected"}, client} =
             Client.recv(client)

    {client, _role_ack} =
      command(client, "v1-command-role-0001", "assign_roles", %{
        "participant_id" => guest.participant_id,
        "role" => "collaborator"
      })

    {client, _transfer_ack} =
      command(client, "v1-command-role-0002", "assign_roles", %{
        "participant_id" => guest.participant_id,
        "role" => "observer"
      })

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
        "command_id" => "v1-command-hand-0002",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "outcome" => "satisfied"}, client} =
             Client.recv(client)

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
