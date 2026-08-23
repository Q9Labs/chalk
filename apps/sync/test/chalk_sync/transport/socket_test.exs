defmodule ChalkSync.Transport.SocketV1Test do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue
  alias ChalkSync.Transport.SocketV1

  @journey_id "10000000-0000-4000-8000-000000000001"
  @trace_id "11111111111111111111111111111111"
  @span_id "2222222222222222"

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
    def append(identity, input, admit_new_message) do
      with :ok <- admit_new_message.(), do: append(identity, input)
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

  test "buffers collaboration read receipts during recovery and delivers them on live transition" do
    receipt = %{
      "type" => "chat_read_receipt",
      "participant_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      "participant_generation" => 1,
      "sequence" => "42",
      "read_at" => "2026-07-29T14:01:00.000Z"
    }

    assert {:ok, initial} = SocketV1.init([])

    recovering = %{
      initial
      | phase: :recovering,
        coordinator: self(),
        collaboration_negotiated: true,
        collaboration_version: 1
    }

    assert {:ok, buffered} =
             SocketV1.handle_info({:collaboration_frame, receipt}, recovering)

    assert {:ok, %{queued_frames: 1}} =
             CollaborationQueue.stats(buffered.collaboration_queue)

    assert {:push, {:text, encoded}, live} =
             SocketV1.handle_info({:sync_recovery_live, self()}, buffered)

    decoded = JSON.decode!(encoded)
    assert Map.take(decoded, Map.keys(receipt)) == receipt
    assert decoded["journey_id"] == buffered.observability.journey_id
    refute Map.has_key?(decoded, "traceparent")
    refute Map.has_key?(decoded, "tracestate")
    assert live.phase == :live
    assert {:ok, %{queued_frames: 0}} = CollaborationQueue.stats(live.collaboration_queue)

    Process.cancel_timer(initial.hello_timer)
    Process.cancel_timer(live.heartbeat_timer)
    assert :ok = CollaborationQueue.close(live.collaboration_queue)
  end

  test "propagates first-observed correlation through recovery, command, pong, and errors", %{
    port: port
  } do
    identity = seed_identity()

    correlation = %{
      "journey_id" => @journey_id,
      "traceparent" => "00-#{@trace_id}-#{@span_id}-00",
      "tracestate" => "acme=first"
    }

    {:ok, client} = Client.connect(port, "/v1/sync")
    client = Client.send_json(client, hello(identity, correlation))

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    assert_correlation(welcome, correlation)

    client = Client.acknowledge_recovery(client, welcome)

    assert {:json, %{"type" => "recovery_complete"} = recovery_complete, client} =
             Client.recv(client)

    assert_correlation(recovery_complete, correlation)

    assert {:json, %{"type" => "projection_snapshot", "stream" => "media"} = media, client} =
             Client.recv(client)

    assert_correlation(media, correlation)

    assert {:json, %{"type" => "projection_snapshot", "stream" => "presence"} = presence, client} =
             Client.recv(client)

    assert_correlation(presence, correlation)

    client = Client.send_json(client, %{"type" => "ping"})
    assert {:json, %{"type" => "pong"} = pong, client} = Client.recv(client)
    assert_correlation(pong, correlation)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "context-command-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "outcome" => "committed"} = ack, client} =
             Client.recv(client)

    assert_correlation(ack, correlation)

    assert {:json, %{"type" => "event", "name" => "hand_raised"} = event, client} =
             Client.recv(client)

    assert_correlation(event, correlation)

    client = Client.send_json(client, %{"type" => "unknown"})
    assert {:json, %{"type" => "error"} = error, _client} = Client.recv(client)
    assert_correlation(error, correlation)
  end

  test "extended Sync v1 negotiates and carries reactions, chat, and paging", %{
    port: port
  } do
    identity = seed_identity()
    {:ok, client} = Client.connect(port, "/v1/sync")

    extended_hello =
      Map.put(hello(identity), "extensions", [
        %{
          "name" => "collaboration_v1",
          "chat_cursor" => %{
            "after_sequence" => nil,
            "retained_floor_sequence" => nil
          }
        }
      ])

    client = Client.send_json(client, extended_hello)

    assert {:json,
            %{
              "type" => "welcome",
              "extensions" => [
                %{
                  "name" => "collaboration_v1",
                  "capabilities" => ["sendReaction", "sendChat"],
                  "chat_head_sequence" => "1",
                  "retained_floor_sequence" => "1"
                }
              ]
            } = welcome, client} = Client.recv(client)

    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} =
      Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "reaction_send",
        "operation_id" => "reaction-op-00001",
        "reaction" => "🎉"
      })

    assert {:json,
            %{
              "type" => "reaction_result",
              "operation_id" => "reaction-op-00001",
              "outcome" => "accepted"
            }, client} = Client.recv(client)

    assert {:json, %{"type" => "reaction", "reaction" => "🎉"}, client} =
             Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "chat_send",
        "client_message_id" => "chat-message-0001",
        "text" => "Hello from Chalk",
        "attachment_ids" => []
      })

    assert {:json,
            %{
              "type" => "chat_send_result",
              "client_message_id" => "chat-message-0001",
              "outcome" => "accepted"
            }, client} = Client.recv(client)

    assert {:json, %{"type" => "chat_head", "head_sequence" => "1"}, client} =
             Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "chat_page_request",
        "request_id" => "chat-page-req-001",
        "direction" => "newer",
        "cursor_sequence" => nil,
        "limit" => 20
      })

    assert {:json,
            %{
              "type" => "chat_page",
              "request_id" => "chat-page-req-001",
              "outcome" => "loaded",
              "messages" => [%{"text" => "Hello from Chalk"}]
            }, _client} = Client.recv(client)
  end

  test "v2 carries attachment-only chat and monotonic read receipts", %{port: port} do
    identity = seed_identity()
    {:ok, client} = Client.connect(port, "/v1/sync")

    extended_hello =
      Map.put(hello(identity), "extensions", [
        %{
          "name" => "collaboration_v1",
          "chat_cursor" => %{
            "after_sequence" => nil,
            "retained_floor_sequence" => nil
          }
        }
      ])

    client = Client.send_json(client, extended_hello)

    assert {:json,
            %{
              "type" => "welcome",
              "extensions" => [
                %{
                  "name" => "collaboration_v1",
                  "read_receipts" => []
                }
              ]
            } = welcome, client} = Client.recv(client)

    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    attachment_id = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c82"

    client =
      Client.send_json(client, %{
        "type" => "chat_send",
        "client_message_id" => "chat-message-0002",
        "text" => "",
        "attachment_ids" => [attachment_id]
      })

    assert {:json,
            %{
              "type" => "chat_send_result",
              "outcome" => "accepted",
              "message" => %{
                "text" => "",
                "attachments" => [
                  %{
                    "attachment_id" => ^attachment_id,
                    "file_name" => "diagram.png",
                    "mime_type" => "image/png",
                    "byte_length" => 32
                  }
                ]
              }
            }, client} = Client.recv(client)

    assert {:json, %{"type" => "chat_head", "head_sequence" => "1"}, client} =
             Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "chat_read_set",
        "request_id" => "chat-read-request-0001",
        "sequence" => "1"
      })

    assert {:json,
            %{
              "type" => "chat_read_result",
              "request_id" => "chat-read-request-0001",
              "outcome" => "accepted",
              "sequence" => "1"
            }, client} = Client.recv(client)

    assert {:json,
            %{
              "type" => "chat_read_receipt",
              "participant_id" => participant_id,
              "sequence" => "1"
            }, _client} = Client.recv(client)

    assert participant_id == identity.participant_id
  end

  test "real v1 operation captures upgrade journey and W3C context", %{port: port} do
    identity = identity()

    assert :ok =
             Memory.seed_episode(identity.episode, [
               %{
                 id: identity.participant_id,
                 generation: identity.participant_generation,
                 display_name: "Ada",
                 capabilities: identity.capabilities,
                 admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
               }
             ])

    assert {:ok, %{result: :already_applied}} =
             Memory.apply_lifecycle_intent(
               identity.episode,
               identity.admission_lifecycle_intent_id
             )

    headers = [
      {"x-chalk-journey-id", @journey_id},
      {"traceparent", "00-#{@trace_id}-#{@span_id}-01"}
    ]

    client = connect_live(port, identity, headers)

    client =
      Client.send_json(client, %{
        "type" => "operation",
        "command_id" => "socket-operation-0001",
        "name" => "participant_leave",
        "payload" => %{}
      })

    assert {:json,
            %{
              "type" => "retryable_error",
              "command_id" => "socket-operation-0001",
              "code" => "external_operation_pending"
            }, _client} = Client.recv(client)

    assert {:ok, operations} = Memory.claim_operations(64)

    assert {_episode, operation} =
             Enum.find(operations, fn {episode, operation} ->
               episode == identity.episode and operation.request_key == "socket-operation-0001"
             end)

    assert operation.journey_id == @journey_id
    assert operation.producing_trace_id == @trace_id
    assert operation.producing_span_id == @span_id
    assert is_binary(operation.parent_journey_event_id)
  end

  test "v1 recovery replaces media and presence before live self-media", %{
    port: port,
    adapter: adapter
  } do
    identity = seed_identity()
    client = connect_live(port, identity)

    client =
      Client.send_json(client, %{
        "type" => "live_target",
        "operation_id" => "live-camera-target-0001",
        "name" => "set_camera_enabled",
        "enabled" => false
      })

    assert {:json,
            %{
              "type" => "live_target_result",
              "operation_id" => "live-camera-target-0001",
              "name" => "set_camera_enabled",
              "outcome" => "confirmed",
              "error_code" => nil
            }, client} = Client.recv(client)

    assert {:revoke_publication, "live-camera-target-0001", arguments} =
             Enum.find(MediaPlaneTestAdapter.calls(adapter), fn {operation, _, _} ->
               operation == :revoke_publication
             end)

    assert [identity.episode, identity.participant_id, :camera] == arguments

    client =
      Client.send_json(client, %{
        "type" => "live_target",
        "operation_id" => "live-screen-target-0001",
        "name" => "set_screen_share_enabled",
        "enabled" => true
      })

    assert {:json,
            %{
              "type" => "live_target_result",
              "operation_id" => "live-screen-target-0001",
              "outcome" => "retryable_failure",
              "error_code" => "dependency_unavailable"
            }, _client} = Client.recv(client)
  end

  test "periodic reconciliation publishes exact-next provider changes without identical spam", %{
    port: port,
    adapter: adapter
  } do
    identity = seed_identity()
    client = connect_live(port, identity)

    publication = %{
      participant_id: identity.participant_id,
      source: :camera,
      enabled: true,
      publication_id: "provider-camera-publication"
    }

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_episode_publications,
      {:ok, [publication]}
    )

    assert {:json,
            %{
              "type" => "projection_event",
              "stream" => "media",
              "sequence" => 1,
              "item" => %{"publication_id" => "provider-camera-publication"}
            }, client} = Client.recv(client, 2_500)

    assert {:error, :timeout} = Client.recv(client, 2_200)

    MediaPlaneTestAdapter.put_outcome(adapter, :observe_episode_publications, {:ok, []})

    assert {:json,
            %{
              "type" => "projection_event",
              "stream" => "media",
              "sequence" => 2,
              "item" => %{"enabled" => false, "publication_id" => nil}
            }, _client} = Client.recv(client, 2_500)
  end

  test "blocked provider reconciliation does not block the coordinator mailbox", %{port: port} do
    identity = seed_identity()
    _client = connect_live(port, identity)
    coordinator = Coordinator.whereis(identity.episode)
    previous_timeout = Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms)

    Application.put_env(:chalk_sync, :media_plane, {BlockingMediaPlane, self()})
    Application.put_env(:chalk_sync, :external_operation_adapter_timeout_ms, 400)

    on_exit(fn ->
      if previous_timeout,
        do:
          Application.put_env(
            :chalk_sync,
            :external_operation_adapter_timeout_ms,
            previous_timeout
          ),
        else: Application.delete_env(:chalk_sync, :external_operation_adapter_timeout_ms)
    end)

    reconcile_started_at = System.monotonic_time(:millisecond)
    assert :ok = Coordinator.reconcile_live(coordinator)
    assert System.monotonic_time(:millisecond) - reconcile_started_at < 250
    assert_receive :blocking_media_observation_started, 250

    mailbox_call_started_at = System.monotonic_time(:millisecond)
    assert :ok = Coordinator.expire_live_requests(coordinator, System.system_time(:millisecond))
    assert System.monotonic_time(:millisecond) - mailbox_call_started_at < 250
  end

  test "directed requests reach only a current active target and release on ACK", %{port: port} do
    actor = identity()
    target = %{identity() | episode: actor.episode}
    seed_participants(actor, [actor, target])

    actor_client = connect_live(port, actor)
    target_client = connect_live(port, target)
    actor_client = receive_presence_replacement(actor_client)

    actor_client =
      Client.send_json(actor_client, %{
        "type" => "directed_request",
        "request_id" => "socket-directed-0001",
        "name" => "request_unmute",
        "target_participant_id" => target.participant_id
      })

    assert {:json,
            %{
              "type" => "directed_request_result",
              "request_id" => "socket-directed-0001",
              "result" => "delivered"
            }, _actor_client} = Client.recv(actor_client)

    assert {:json,
            %{
              "type" => "directed_request",
              "request_id" => "socket-directed-0001",
              "actor_participant_id" => actor_id
            }, target_client} = Client.recv(target_client)

    assert actor_id == actor.participant_id

    target_client =
      Client.send_json(target_client, %{
        "type" => "request_ack",
        "request_id" => "socket-directed-0001"
      })

    assert {:error, :timeout} = Client.recv(target_client, 25)

    actor_client =
      Client.send_json(actor_client, %{
        "type" => "directed_request",
        "request_id" => "socket-directed-0002",
        "name" => "request_start_camera",
        "target_participant_id" => target.participant_id
      })

    assert {:json, %{"request_id" => "socket-directed-0002", "result" => "delivered"},
            actor_client} = Client.recv(actor_client)

    assert {:json, %{"request_id" => "socket-directed-0002"}, _target_client} =
             Client.recv(target_client)

    coordinator = Coordinator.whereis(actor.episode)

    assert :ok =
             Coordinator.expire_live_requests(
               coordinator,
               System.system_time(:millisecond) + 31_000
             )

    assert {:json, %{"request_id" => "socket-directed-0002", "result" => "expired"},
            _actor_client} = Client.recv(actor_client)
  end

  test "v1 rejects live work until replacement snapshots complete recovery", %{port: port} do
    identity = seed_identity()
    {:ok, client} = Client.connect(port, "/v1/sync")
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome"}, client} = Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "live_target",
        "operation_id" => "too-early-target-0001",
        "name" => "set_camera_enabled",
        "enabled" => false
      })

    assert {:json, %{"type" => "error", "detail" => "recovery_required"}, _client} =
             Client.recv(client)
  end

  test "v1 rejects the legacy token capability shape at the socket identity boundary", %{
    port: port
  } do
    identity = seed_identity()

    legacy_token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "capabilities" => ["endMeeting"],
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    {:ok, client} = Client.connect(port, "/v1/sync")
    client = Client.send_json(client, Map.put(hello(identity), "token", legacy_token))
    assert {:closed, 1008, "invalid token", _client} = Client.recv(client)
  end

  test "operation terminal decisions encode stable ACKs without internal operation ids" do
    decision = %OperationDecision{
      request_key: "terminal-operation-0001",
      result: :applied,
      delivery: :duplicate,
      external_operation_id: "00000000-0000-4000-8000-000000000099",
      event_id: "00000000-0000-4000-8000-000000000098",
      revision: 4,
      state_digest: <<0::256>>
    }

    assert {:ok, applied} = decision |> ProtocolV1.operation_decision() |> JSON.decode()
    refute Map.has_key?(applied, "external_operation_id")
    assert applied["outcome"] == "committed"
    assert applied["delivery"] == "duplicate"

    failed = %{decision | result: :failed, event_id: nil, revision: nil, state_digest: nil}
    assert {:ok, rejected} = failed |> ProtocolV1.operation_decision() |> JSON.decode()
    assert rejected["outcome"] == "rejected"
    assert rejected["reason"] == "external_operation_failed"
    refute Map.has_key?(rejected, "external_operation_id")
  end

  test "terminal control delivery waits for the exact client acknowledgement", %{port: port} do
    identity = seed_identity()
    client = connect_live(port, identity)

    client =
      Client.send_json(client, %{
        "type" => "operation",
        "command_id" => "terminal-ack-operation-0001",
        "name" => "end_episode",
        "payload" => %{}
      })

    assert {:json,
            %{
              "type" => "retryable_error",
              "command_id" => "terminal-ack-operation-0001",
              "code" => "external_operation_pending"
            }, client} = Client.recv(client)

    assert {:ok, operations} = Memory.claim_operations(64)

    assert {_episode, %ExternalOperation{} = operation} =
             Enum.find(operations, fn {episode, operation} ->
               episode == identity.episode and
                 operation.request_key == "terminal-ack-operation-0001"
             end)

    assert {:ok, decision} =
             Memory.finalize_operation(
               identity.episode,
               operation.external_operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    Coordinator.hint(identity.episode, decision.revision)

    assert {:json,
            %{
              "type" => "event",
              "name" => "episode_ended",
              "revision" => revision,
              "resulting_state_digest" => state_digest
            }, client} = Client.recv(client)

    assert {:error, :timeout, client} = Client.recv_frame(client, 50)

    client =
      Client.send_json(client, %{
        "type" => "delivery_ack",
        "stream" => "control",
        "revision" => revision,
        "state_digest" => state_digest
      })

    assert {:closed, 1000, "terminal event acknowledged", _client} = Client.recv(client)
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

  test "durable command event telemetry survives a dropped result and ignores duplicate receipts",
       %{
         port: port
       } do
    handler_id = "socket-command-observability-#{System.unique_integer([:positive])}"
    parent = self()
    previous_gate = Application.get_env(:chalk_sync, :delivery_gate_adapter)

    :ok =
      :telemetry.attach(
        handler_id,
        [:chalk_sync, :observability, :event],
        fn _event, _measurements, metadata, _config ->
          if metadata.event == "sync.episode.event.committed" do
            send(parent, {:episode_event, metadata})
          end
        end,
        nil
      )

    Application.put_env(:chalk_sync, :delivery_gate_adapter, DropCommandResultGate)

    on_exit(fn ->
      :telemetry.detach(handler_id)
      restore_env(:delivery_gate_adapter, previous_gate)
    end)

    identity = seed_identity()

    correlation = %{
      "journey_id" => @journey_id,
      "traceparent" => "00-#{@trace_id}-#{@span_id}-01"
    }

    client = connect_live(port, identity, [], correlation)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "dropped-command-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    _client = Client.close_tcp(client)

    assert_receive {:episode_event,
                    %{
                      event: "sync.episode.event.committed",
                      journey_id: @journey_id,
                      attributes: %{event_name: "hand_raised"}
                    }},
                   2_000

    Application.delete_env(:chalk_sync, :delivery_gate_adapter)
    client = connect_live(port, identity, [], correlation)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "dropped-command-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "delivery" => "duplicate"}, client} = Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "rejected-command-0001",
        "name" => "assign_roles",
        "payload" => %{
          "participant_id" => "00000000-0000-4000-8000-000000000099",
          "role" => "observer"
        }
      })

    assert {:json, %{"type" => "ack", "outcome" => "rejected"}, _client} = Client.recv(client)
    refute_receive {:episode_event, _metadata}, 500
  end

  defp hello(identity, correlation \\ %{}) do
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

  defp seed_identity do
    identity = identity()
    seed_participants(identity, [identity])
    identity
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

  defp assert_correlation(frame, correlation) do
    assert frame["journey_id"] == correlation["journey_id"]
    assert frame["traceparent"] == correlation["traceparent"]
    assert frame["tracestate"] == correlation["tracestate"]
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp receive_presence_replacement(client) do
    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} =
      Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    client
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
