defmodule ChalkSync.RoomActionsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedV3
  alias ChalkSync.RoomActions
  alias ChalkSync.RoomActions.Admission
  alias ChalkSync.RoomActions.Fanout
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  defmodule Repository do
    @behaviour ChalkSync.RoomActions.ChatRepository

    @message %{
      message_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c81",
      client_message_id: "chat-message-0001",
      sequence: "42",
      participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      display_name: "Ada",
      text: "Hello from Chalk",
      attachments: [],
      created_at: "2026-07-29T14:00:00.000Z"
    }

    @receipt %{
      participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_session_generation: 1,
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
           identity.participant_session_id =>
             Enum.filter(["sendReaction", "sendChat"], &(&1 in identity.capabilities))
         }
       }}
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
    def head(_session) do
      {:ok, %{head_sequence: "42", retained_floor_sequence: "7"}}
    end

    @impl true
    def read_receipts(_session), do: {:ok, [@receipt]}

    @impl true
    def mark_read(_identity, "42") do
      {:ok, %{outcome: :advanced, receipt: @receipt}}
    end

    def mark_read(_identity, _sequence), do: {:error, :invalid_payload}

    @impl true
    def read_page(_session, %{direction: :newer, cursor_sequence: "41", limit: 10}) do
      {:ok,
       %{
         messages: [@message],
         has_more: false,
         head_sequence: "42",
         retained_floor_sequence: "7"
       }}
    end

    def read_page(_session, %{cursor_sequence: "1"}) do
      {:cursor_reset, "7"}
    end

    def read_page(_session, _request), do: {:error, :invalid_payload}
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
             RoomActions.negotiate(
               identity,
               %{after_sequence: "41", retained_floor_sequence: "7"},
               self(),
               options
             )

    assert extension == %{
             "name" => "room_actions_v1",
             "capabilities" => ["sendReaction", "sendChat"],
             "participant_capabilities" => %{
               identity.participant_session_id => ["sendReaction", "sendChat"]
             },
             "chat_head_sequence" => "42",
             "retained_floor_sequence" => "7"
           }

    assert %{sessions: 1, subscribers: 1} = Fanout.stats(fanout)
    assert :ok = Fanout.unsubscribe(fanout, identity.session, self())
    assert %{sessions: 0, subscribers: 0} = Fanout.stats(fanout)
  end

  test "stamps, broadcasts, and acknowledges an allowlisted reaction", %{options: options} do
    identity = identity()

    assert {:ok, _extension} =
             RoomActions.negotiate(
               identity,
               %{after_sequence: nil, retained_floor_sequence: nil},
               self(),
               options
             )

    clock = fn -> DateTime.from_iso8601("2026-07-29T14:00:00.000Z") |> elem(1) end

    assert {:ok, result} =
             RoomActions.send_reaction(
               identity,
               %{operation_id: "reaction-op-00001", reaction: "🎉"},
               Keyword.put(options, :clock, clock)
             )

    assert result["outcome"] == "accepted"
    assert result["reaction"]["display_name"] == "Ada"
    assert result["reaction"]["occurred_at"] == "2026-07-29T14:00:00.000Z"
    assert result["reaction"]["expires_at"] == "2026-07-29T14:00:05.000Z"
    assert GeneratedV3.valid_server_frame?(result)
    assert_receive {:room_action_frame, event}
    assert event == result["reaction"]
  end

  test "negotiates v2 with receipt watermarks", %{options: options} do
    identity = identity()

    assert {:ok, extension} =
             RoomActions.negotiate(
               identity,
               %{
                 extension: "room_actions_v2",
                 after_sequence: "41",
                 retained_floor_sequence: "7"
               },
               self(),
               options
             )

    assert extension["name"] == "room_actions_v2"

    assert extension["read_receipts"] == [
             %{
               "participant_session_id" => identity.participant_session_id,
               "participant_session_generation" => 1,
               "sequence" => "42",
               "read_at" => "2026-07-29T14:01:00.000Z"
             }
           ]
  end

  test "returns a committed chat message and a durable head hint", %{options: options} do
    identity = identity()

    assert {:ok, _extension} =
             RoomActions.negotiate(
               identity,
               %{after_sequence: "41", retained_floor_sequence: "7"},
               self(),
               options
             )

    assert {:ok, result} =
             RoomActions.send_chat(
               identity,
               %{client_message_id: "chat-message-0001", text: "Hello from Chalk"},
               options
             )

    assert result["outcome"] == "accepted"
    assert result["message"]["sequence"] == "42"
    assert GeneratedV3.valid_server_frame?(result)

    assert_receive {:room_action_frame,
                    %{
                      "type" => "chat_head",
                      "head_sequence" => "42",
                      "retained_floor_sequence" => "7"
                    }}
  end

  test "returns attachment-only v2 chat and advances read receipt", %{
    options: options
  } do
    identity = identity()
    options = Keyword.put(options, :version, 2)

    assert {:ok, _extension} =
             RoomActions.negotiate(
               identity,
               %{
                 extension: "room_actions_v2",
                 after_sequence: "41",
                 retained_floor_sequence: "7"
               },
               self(),
               options
             )

    assert {:ok, chat_result} =
             RoomActions.send_chat(
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
             RoomActions.mark_chat_read(
               identity,
               %{request_id: "chat-read-request-0001", sequence: "42"},
               options
             )

    assert read_result["outcome"] == "accepted"
    assert read_result["sequence"] == "42"
    assert GeneratedV3.valid_server_frame?(read_result)

    assert_receive {:room_action_frame,
                    %{
                      "type" => "chat_read_receipt",
                      "participant_session_id" => participant_session_id,
                      "sequence" => "42"
                    }}

    assert participant_session_id == identity.participant_session_id
  end

  test "returns generated-valid loaded and cursor-reset pages", %{options: options} do
    identity = identity()

    assert {:ok, loaded} =
             RoomActions.read_chat_page(
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
    assert GeneratedV3.valid_server_frame?(loaded)

    assert {:ok, reset} =
             RoomActions.read_chat_page(
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
    assert GeneratedV3.valid_server_frame?(reset)
  end

  test "returns a generated-valid capability rejection", %{options: options} do
    identity = %{identity() | capabilities: []}

    assert {:ok, result} =
             RoomActions.send_reaction(
               identity,
               %{operation_id: "reaction-op-00001", reaction: "🎉"},
               options
             )

    assert result["error_code"] == "capability_denied"
    assert GeneratedV3.valid_server_frame?(result)
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        room_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_session_generation: 1,
      capabilities: ["sendReaction", "sendChat"]
    }
  end
end
