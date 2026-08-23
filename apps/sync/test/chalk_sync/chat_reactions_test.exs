defmodule ChalkSync.ChatReactionsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Admission
  alias ChalkSync.Chat
  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Fanout.Collaboration, as: Fanout
  alias ChalkSync.Reactions
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  defmodule Repository do
    @behaviour ChalkSync.Chat.Repository

    @message %{
      message_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c81",
      client_message_id: "chat-message-0001",
      sequence: "42",
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      display_name: "Ada",
      text: "Hello from Chalk",
      attachments: [],
      created_at: "2026-07-29T14:00:00.000Z"
    }

    @receipt %{
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_generation: 1,
      sequence: "42",
      read_at: "2026-07-29T14:01:00.000Z"
    }

    @impl true
    def authorize(_identity, nil), do: {:ok, %{display_name: "Ada"}}

    def authorize(identity, capability) do
      if capability in identity.capabilities,
        do: {:ok, %{display_name: "Ada"}},
        else: {:error, :capability_denied}
    end

    @impl true
    def participant_capabilities(identity) do
      {:ok,
       %{
         capabilities: Enum.filter(["sendReaction", "sendChat"], &(&1 in identity.capabilities)),
         participant_capabilities: %{
           identity.participant_id =>
             Enum.filter(["sendReaction", "sendChat"], &(&1 in identity.capabilities))
         }
       }}
    end

    @impl true
    def append(identity, input, admit_new_message) do
      with :ok <- admit_new_message.(), do: append(identity, input)
    end

    @impl true
    def append(_identity, %{
          client_message_id: "chat-message-0001",
          text: "Hello from Chalk",
          attachment_ids: []
        }) do
      {:ok, %{outcome: :committed, message: @message}}
    end

    def append(_identity, %{
          client_message_id: "chat-message-0002",
          text: "",
          attachment_ids: ["018f2f65-2a77-7a44-8e9a-5b0b6f8d4c82"]
        }) do
      {:ok,
       %{
         outcome: :committed,
         message: %{
           @message
           | client_message_id: "chat-message-0002",
             text: "",
             attachments: [
               %{
                 attachment_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c82",
                 file_name: "board.png",
                 mime_type: "image/png",
                 byte_length: 2048
               }
             ]
         }
       }}
    end

    def append(_identity, _input), do: {:error, :invalid_payload}

    @impl true
    def head(_episode) do
      {:ok, %{head_sequence: "42", retained_floor_sequence: "7"}}
    end

    @impl true
    def read_receipts(_episode), do: {:ok, [@receipt]}

    @impl true
    def mark_read(_identity, "42") do
      {:ok, %{outcome: :advanced, receipt: @receipt}}
    end

    def mark_read(_identity, _sequence), do: {:error, :invalid_payload}

    @impl true
    def read_page(_episode, %{direction: :newer, cursor_sequence: "41", limit: 10}) do
      {:ok,
       %{
         messages: [@message],
         has_more: false,
         head_sequence: "42",
         retained_floor_sequence: "7"
       }}
    end

    def read_page(_episode, %{cursor_sequence: "1"}) do
      {:cursor_reset, "7"}
    end

    def read_page(_episode, _request), do: {:error, :invalid_payload}
  end

  defmodule DuplicateRepository do
    alias ChalkSync.ChatReactionsTest.Repository

    def append(identity, input, _admit_new_message) do
      send(self(), :duplicate_repository_called)

      with {:ok, %{message: message}} <- Repository.append(identity, input) do
        {:ok, %{outcome: :duplicate, message: message}}
      end
    end
  end

  defmodule DeniedRepository do
    def append(_identity, _input, _admit_new_message), do: {:error, :capability_denied}
  end

  setup do
    admission = start_supervised!({Admission, name: nil})
    fanout = start_supervised!({Fanout, name: nil})
    options = [repository: Repository, admission: admission, fanout: fanout]
    %{admission: admission, fanout: fanout, options: options}
  end

  test "negotiates the exact extension and manages the socket subscription", %{
    fanout: fanout,
    options: options
  } do
    identity = identity()

    assert {:ok, extension} =
             Chat.negotiate(
               identity,
               %{after_sequence: "41", retained_floor_sequence: "7"},
               self(),
               options
             )

    assert extension == %{
             "name" => "collaboration_v1",
             "capabilities" => ["sendReaction", "sendChat"],
             "participant_capabilities" => %{
               identity.participant_id => ["sendReaction", "sendChat"]
             },
             "chat_head_sequence" => "42",
             "retained_floor_sequence" => "7",
             "read_receipts" => [
               %{
                 "participant_id" => identity.participant_id,
                 "participant_generation" => 1,
                 "sequence" => "42",
                 "read_at" => "2026-07-29T14:01:00.000Z"
               }
             ]
           }

    assert %{episodes: 1, subscribers: 1} = Fanout.stats(fanout)
    assert :ok = Fanout.unsubscribe(fanout, identity.episode, self())
    assert %{episodes: 0, subscribers: 0} = Fanout.stats(fanout)
  end

  test "stamps, broadcasts, and acknowledges an allowlisted reaction", %{options: options} do
    identity = identity()

    assert {:ok, _extension} =
             Chat.negotiate(
               identity,
               %{after_sequence: nil, retained_floor_sequence: nil},
               self(),
               options
             )

    clock = fn -> DateTime.from_iso8601("2026-07-29T14:00:00.000Z") |> elem(1) end

    assert {:ok, result} =
             Reactions.send(
               identity,
               %{operation_id: "reaction-op-00001", reaction: "🎉"},
               Keyword.put(options, :clock, clock)
             )

    assert result["outcome"] == "accepted"
    assert result["reaction"]["display_name"] == "Ada"
    assert result["reaction"]["occurred_at"] == "2026-07-29T14:00:00.000Z"
    assert result["reaction"]["expires_at"] == "2026-07-29T14:00:05.000Z"
    assert GeneratedV1.valid_server_frame?(result)
    assert_receive {:collaboration_frame, event}
    assert event == result["reaction"]
  end

  test "negotiates v2 with receipt watermarks", %{options: options} do
    identity = identity()

    assert {:ok, extension} =
             Chat.negotiate(
               identity,
               %{
                 extension: "collaboration_v1",
                 after_sequence: "41",
                 retained_floor_sequence: "7"
               },
               self(),
               options
             )

    assert extension["name"] == "collaboration_v1"

    assert extension["read_receipts"] == [
             %{
               "participant_id" => identity.participant_id,
               "participant_generation" => 1,
               "sequence" => "42",
               "read_at" => "2026-07-29T14:01:00.000Z"
             }
           ]
  end

  test "returns a committed chat message and a durable head hint", %{options: options} do
    identity = identity()

    assert {:ok, _extension} =
             Chat.negotiate(
               identity,
               %{after_sequence: "41", retained_floor_sequence: "7"},
               self(),
               options
             )

    assert {:ok, result} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               options
             )

    assert result["outcome"] == "accepted"
    assert result["message"]["sequence"] == "42"
    assert GeneratedV1.valid_server_frame?(result)

    assert_receive {:collaboration_frame,
                    %{
                      "type" => "chat_head",
                      "head_sequence" => "42",
                      "retained_floor_sequence" => "7"
                    }}
  end

  test "rejects new chat sends at the shared participant rate after durable checks", %{
    options: options
  } do
    {:ok, admission} = Admission.start_link(name: nil, chat_rate_max: 1)
    on_exit(fn -> if Process.alive?(admission), do: GenServer.stop(admission) end)

    options = Keyword.put(options, :admission, admission)
    identity = identity()

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               options
             )

    assert {:ok, %{"outcome" => "rejected", "error_code" => "rate_limited"}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0002", text: "Second message"},
               options
             )
  end

  test "bounds duplicate attempts without charging the new-message budget", %{options: options} do
    {:ok, admission} =
      Admission.start_link(name: nil, chat_attempt_rate_max: 1, chat_rate_max: 1)

    on_exit(fn -> if Process.alive?(admission), do: GenServer.stop(admission) end)
    identity = identity()
    assert :ok = Admission.admit_chat(admission, identity)

    options =
      options
      |> Keyword.put(:admission, admission)
      |> Keyword.put(:repository, DuplicateRepository)

    assert {:ok, %{"outcome" => "accepted", "message" => %{"sequence" => "42"}}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               options
             )

    assert_receive :duplicate_repository_called

    assert {:ok, %{"outcome" => "rejected", "error_code" => "rate_limited"}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "conflicting retry"},
               options
             )

    refute_receive :duplicate_repository_called
  end

  test "does not charge the local chat budget for a durable authority denial", %{
    options: options
  } do
    {:ok, admission} = Admission.start_link(name: nil, chat_rate_max: 1)
    on_exit(fn -> if Process.alive?(admission), do: GenServer.stop(admission) end)
    identity = identity()

    denied_options =
      options
      |> Keyword.put(:admission, admission)
      |> Keyword.put(:repository, DeniedRepository)

    assert {:ok, %{"outcome" => "rejected", "error_code" => "capability_denied"}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-denied", text: "Denied"},
               denied_options
             )

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               Keyword.put(options, :admission, admission)
             )
  end

  test "fails chat closed when shared admission is unavailable", %{options: options} do
    options = Keyword.put(options, :admission, :missing_chat_admission)

    assert {:ok, %{"outcome" => "rejected", "error_code" => "overloaded"}} =
             Chat.send_chat(
               identity(),
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               options
             )
  end

  test "returns attachment-only v2 chat and advances read receipt", %{
    options: options
  } do
    identity = identity()
    options = Keyword.put(options, :version, 2)

    assert {:ok, _extension} =
             Chat.negotiate(
               identity,
               %{
                 extension: "collaboration_v1",
                 after_sequence: "41",
                 retained_floor_sequence: "7"
               },
               self(),
               options
             )

    assert {:ok, chat_result} =
             Chat.send_chat(
               identity,
               %{
                 client_message_id: "chat-message-0002",
                 text: "",
                 attachment_ids: ["018f2f65-2a77-7a44-8e9a-5b0b6f8d4c82"]
               },
               options
             )

    assert chat_result["message"]["text"] == ""

    assert chat_result["message"]["attachments"] == [
             %{
               "attachment_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c82",
               "file_name" => "board.png",
               "mime_type" => "image/png",
               "byte_length" => 2048
             }
           ]

    assert {:ok, read_result} =
             Chat.mark_chat_read(
               identity,
               %{request_id: "chat-read-request-0001", sequence: "42"},
               options
             )

    assert read_result["outcome"] == "accepted"
    assert read_result["sequence"] == "42"
    assert GeneratedV1.valid_server_frame?(read_result)

    assert_receive {:collaboration_frame,
                    %{
                      "type" => "chat_read_receipt",
                      "participant_id" => participant_id,
                      "sequence" => "42"
                    }}

    assert participant_id == identity.participant_id
  end

  test "returns generated-valid loaded and cursor-reset pages", %{options: options} do
    identity = identity()

    assert {:ok, loaded} =
             Chat.read_chat_page(
               identity,
               %{
                 request_id: "chat-page-req-001",
                 direction: "newer",
                 cursor_sequence: "41",
                 limit: 10
               },
               options
             )

    assert loaded["outcome"] == "loaded"
    assert GeneratedV1.valid_server_frame?(loaded)

    assert {:ok, reset} =
             Chat.read_chat_page(
               identity,
               %{
                 request_id: "chat-page-req-002",
                 direction: "older",
                 cursor_sequence: "1",
                 limit: 10
               },
               options
             )

    assert reset["outcome"] == "cursor_reset"
    assert GeneratedV1.valid_server_frame?(reset)
  end

  test "returns a generated-valid capability rejection", %{options: options} do
    identity = %{identity() | capabilities: []}

    assert {:ok, result} =
             Reactions.send(
               identity,
               %{operation_id: "reaction-op-00001", reaction: "🎉"},
               options
             )

    assert result["error_code"] == "capability_denied"
    assert GeneratedV1.valid_server_frame?(result)
  end

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        space_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        episode_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_generation: 1,
      capabilities: ["sendReaction", "sendChat"]
    }
  end
end
