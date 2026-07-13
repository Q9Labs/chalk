defmodule ChalkSync.Transport.SocketV3Test do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.ProtocolV3
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.TestWSClient, as: Client

  @journey_id "10000000-0000-4000-8000-000000000001"
  @trace_id "11111111111111111111111111111111"
  @span_id "2222222222222222"

  defmodule BlockingMediaPlane do
    @moduledoc false

    @behaviour ChalkSync.MediaPlane

    @impl true
    def observe_session_publications(controller, _session) do
      send(controller, :blocking_media_observation_started)
      Process.sleep(:infinity)
    end

    @impl true
    def grant_publication(_adapter, _operation_id, _session, _participant_id, _source),
      do: :confirmed

    @impl true
    def revoke_publication(_adapter, _operation_id, _session, _participant_id, _source),
      do: :confirmed

    @impl true
    def remove_participant(_adapter, _operation_id, _session, _participant_id), do: :confirmed

    @impl true
    def end_session(_adapter, _operation_id, _session), do: :confirmed
  end

  setup do
    previous = Application.get_env(:chalk_sync, :media_plane)
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    {:ok, adapter: adapter}
  end

  test "real v3 operation captures upgrade journey and W3C context", %{port: port} do
    identity = identity()

    assert :ok =
             Memory.seed_session(identity.session, [
               %{
                 id: identity.participant_session_id,
                 generation: identity.participant_session_generation,
                 display_name: "Ada",
                 capabilities: identity.capabilities,
                 admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
               }
             ])

    assert {:ok, %{result: :already_applied}} =
             Memory.apply_lifecycle_intent(
               identity.session,
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

    assert {_session, operation} =
             Enum.find(operations, fn {session, operation} ->
               session == identity.session and operation.request_key == "socket-operation-0001"
             end)

    assert operation.journey_id == @journey_id
    assert operation.producing_trace_id == @trace_id
    assert operation.producing_span_id == @span_id
    assert is_binary(operation.parent_journey_event_id)
  end

  test "v3 recovery replaces media and presence before live self-media", %{
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

    assert [identity.session, identity.participant_session_id, :camera] == arguments

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
      participant_session_id: identity.participant_session_id,
      source: :camera,
      enabled: true,
      publication_id: "provider-camera-publication"
    }

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_session_publications,
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

    MediaPlaneTestAdapter.put_outcome(adapter, :observe_session_publications, {:ok, []})

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
    coordinator = Coordinator.whereis(identity.session)
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
    target = %{identity() | session: actor.session}
    seed_participants(actor, [actor, target])

    actor_client = connect_live(port, actor)
    target_client = connect_live(port, target)
    actor_client = receive_presence_replacement(actor_client)

    actor_client =
      Client.send_json(actor_client, %{
        "type" => "directed_request",
        "request_id" => "socket-directed-0001",
        "name" => "request_unmute",
        "target_participant_session_id" => target.participant_session_id
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
              "actor_participant_session_id" => actor_id
            }, target_client} = Client.recv(target_client)

    assert actor_id == actor.participant_session_id

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
        "target_participant_session_id" => target.participant_session_id
      })

    assert {:json, %{"request_id" => "socket-directed-0002", "result" => "delivered"},
            actor_client} = Client.recv(actor_client)

    assert {:json, %{"request_id" => "socket-directed-0002"}, _target_client} =
             Client.recv(target_client)

    coordinator = Coordinator.whereis(actor.session)

    assert :ok =
             Coordinator.expire_live_requests(
               coordinator,
               System.system_time(:millisecond) + 31_000
             )

    assert {:json, %{"request_id" => "socket-directed-0002", "result" => "expired"},
            _actor_client} = Client.recv(actor_client)
  end

  test "v3 rejects live work until replacement snapshots complete recovery", %{port: port} do
    identity = seed_identity()
    {:ok, client} = Client.connect(port, "/v3/sync")
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

  test "v3 rejects the legacy token capability shape at the socket identity boundary", %{
    port: port
  } do
    identity = seed_identity()

    legacy_token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "capabilities" => ["endMeeting"],
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    {:ok, client} = Client.connect(port, "/v3/sync")
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

    assert {:ok, applied} = decision |> ProtocolV3.operation_decision() |> JSON.decode()
    refute Map.has_key?(applied, "external_operation_id")
    assert applied["outcome"] == "committed"
    assert applied["delivery"] == "duplicate"

    failed = %{decision | result: :failed, event_id: nil, revision: nil, state_digest: nil}
    assert {:ok, rejected} = failed |> ProtocolV3.operation_decision() |> JSON.decode()
    assert rejected["outcome"] == "rejected"
    assert rejected["reason"] == "external_operation_failed"
    refute Map.has_key?(rejected, "external_operation_id")
  end

  test "all five v3 durable commands use exact ACKs and event delivery", %{port: port} do
    host = identity()
    guest = %{identity() | session: host.session}
    seed_participants(host, [host, guest])
    client = connect_live(port, host)

    {client, hand_ack} =
      command(client, "v3-command-hand-0001", "set_hand_raised", %{"raised" => true})

    assert hand_ack["outcome"] == "committed"

    {client, _display_ack} =
      command(client, "v3-command-name-0001", "set_display_name", %{
        "display_name" => "Ada Lovelace"
      })

    {client, _policy_ack} =
      command(client, "v3-command-policy-01", "set_admission_policy", %{
        "policy" => "approval"
      })

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v3-command-reject-01",
        "name" => "set_participant_role",
        "payload" => %{
          "participant_session_id" => "00000000-0000-4000-8000-000000000099",
          "role" => "cohost"
        }
      })

    assert {:json, %{"type" => "ack", "outcome" => "rejected"}, client} =
             Client.recv(client)

    {client, _role_ack} =
      command(client, "v3-command-role-0001", "set_participant_role", %{
        "participant_session_id" => guest.participant_session_id,
        "role" => "cohost"
      })

    {client, _transfer_ack} =
      command(client, "v3-command-host-0001", "transfer_host", %{
        "participant_session_id" => guest.participant_session_id
      })

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v3-command-hand-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "delivery" => "duplicate"} = duplicate, client} =
             Client.recv(client)

    assert duplicate["event_id"] == hand_ack["event_id"]

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v3-command-hand-0002",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => true}
      })

    assert {:json, %{"type" => "ack", "outcome" => "satisfied"}, client} =
             Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "v3-command-hand-0001",
        "name" => "set_hand_raised",
        "payload" => %{"raised" => false}
      })

    assert {:json, %{"type" => "ack", "outcome" => "command_id_conflict"}, _client} =
             Client.recv(client)
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "initial_role" => identity.role || "participant",
        "eligible_roles" =>
          if(identity.eligible_roles == [], do: ["participant"], else: identity.eligible_roles),
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 3,
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  defp connect_live(port, identity, headers \\ []) do
    {:ok, client} = Client.connect(port, "/v3/sync", headers)
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome", "protocol" => 3} = welcome, client} = Client.recv(client)
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

    assert Enum.any?(presence, &(&1["participant_session_id"] == identity.participant_session_id))
    client
  end

  defp seed_identity do
    identity = identity()
    seed_participants(identity, [identity])
    identity
  end

  defp seed_participants(owner, participants) do
    assert :ok =
             Memory.seed_session(
               owner.session,
               Enum.map(participants, fn identity ->
                 %{
                   id: identity.participant_session_id,
                   generation: identity.participant_session_generation,
                   display_name: "Participant",
                   eligible_roles: ["host", "cohost", "participant"],
                   capabilities: identity.capabilities,
                   admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
                 }
               end)
             )

    Enum.each(participants, fn identity ->
      assert {:ok, %{result: :already_applied}} =
               Memory.apply_lifecycle_intent(
                 identity.session,
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
      session: %SessionKey{
        tenant_id: uuid(suffix),
        room_id: uuid(suffix + 1),
        session_id: uuid(suffix + 2)
      },
      participant_session_id: uuid(suffix + 3),
      participant_session_generation: 1,
      admission_lifecycle_intent_id: uuid(suffix + 4),
      capabilities: ["control:hand"]
    }
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")
    "018f2f65-2a77-4a44-8e9a-#{suffix}"
  end
end
