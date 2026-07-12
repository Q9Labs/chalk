defmodule ChalkSync.Transport.SocketV2Test do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.SocketV2

  test "real v2 wire recovers, commits, and treats TCP loss as volatile", %{port: port} do
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

    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(identity))

    {:json, welcome, client} = Client.recv(client)
    assert %{"type" => "welcome", "protocol" => 2, "mode" => "snapshot"} = welcome
    assert welcome["participant_session_id"] == identity.participant_session_id
    assert welcome["snapshot"]["control_revision"] == 1
    client = Client.acknowledge_recovery(client, welcome)

    {:json, complete, client} = Client.recv(client)
    assert %{"type" => "recovery_complete"} = complete
    assert complete["head"] == welcome["head"]

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "wire-command-0001",
        "name" => "raise_hand",
        "payload" => %{}
      })

    {:json, ack, client} = Client.recv(client)
    assert %{"type" => "ack", "result" => "committed", "revision" => 2} = ack

    {:json, event, client} = Client.recv(client)
    assert %{"type" => "event", "name" => "hand_raised", "revision" => 2} = event
    assert event["command_id"] == "wire-command-0001"

    _closed = Client.close_tcp(client)
    Process.sleep(10)

    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert recovery.head.revision == 2
    assert hd(recovery.snapshot["participants"])["hand_raised"]
  end

  test "same revision with a wrong digest forces snapshot replacement", %{port: port} do
    identity = identity()

    assert :ok =
             Memory.seed_session(identity.session, [
               %{
                 id: identity.participant_session_id,
                 generation: 1,
                 display_name: "Ada",
                 admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
               }
             ])

    cursor = %{
      "revision" => 1,
      "state_schema_version" => 1,
      "state_digest" => String.duplicate("0", 64)
    }

    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(identity, cursor))
    {:json, welcome, _client} = Client.recv(client)

    assert welcome["mode"] == "snapshot"
    assert welcome["snapshot"]["state_digest"] != cursor["state_digest"]
  end

  test "replay is demand-paged and orders a racing live event after completion", %{port: port} do
    identity = identity()

    assert :ok =
             Memory.seed_session(identity.session, [
               %{
                 id: identity.participant_session_id,
                 generation: 1,
                 display_name: "Ada",
                 capabilities: identity.capabilities,
                 admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
               }
             ])

    assert {:ok, initial} = Memory.recover(identity, nil)

    cursor = %{
      "revision" => initial.head.revision,
      "state_schema_version" => initial.head.state_schema_version,
      "state_digest" => Base.encode16(initial.head.digest, case: :lower)
    }

    Enum.each(1..129, fn index ->
      name = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand

      assert {:ok, command} =
               Command.new(
                 "paged-replay-#{String.pad_leading(to_string(index), 4, "0")}",
                 name,
                 %{}
               )

      assert {:ok, %{result: :committed, revision: revision}} =
               Memory.decide_command(identity, command)

      assert revision == index + 1
    end)

    assert {:ok, planned} = Memory.recover(identity, initial.head)
    assert planned.mode == :replay
    assert planned.events == []
    assert planned.replay_cursor == 1

    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(identity, cursor))
    {:json, %{"type" => "welcome", "mode" => "replay"}, client} = Client.recv(client)

    assert {:ok, live_command} = Command.new("paged-replay-live-0131", :lower_hand, %{})
    assert {:ok, live_decision} = Memory.decide_command(identity, live_command)
    assert live_decision.revision == 131
    assert :ok = Coordinator.publish(identity.session, live_decision.event)

    {:json, first_page, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, first_page)
    {:json, second_page, client} = Client.recv(client)

    assert %{"type" => "replay_page", "first_revision" => 2, "last_revision" => 129} =
             first_page

    assert length(first_page["events"]) == 128

    assert %{"type" => "replay_page", "first_revision" => 130, "last_revision" => 130} =
             second_page

    client = Client.acknowledge_recovery(client, second_page)

    {:json, %{"type" => "recovery_complete", "head" => %{"revision" => 130}}, client} =
      Client.recv(client)

    assert {:json, %{"type" => "event", "revision" => 131}, _client} = Client.recv(client)
  end

  test "multiple sockets fan out exact events and one socket loss changes no lifecycle", %{
    port: port
  } do
    identity = identity()

    assert :ok =
             Memory.seed_session(identity.session, [
               %{
                 id: identity.participant_session_id,
                 generation: 1,
                 display_name: "Ada",
                 capabilities: identity.capabilities,
                 admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
               }
             ])

    first = connect_live(port, identity)
    second = connect_live(port, identity)

    first =
      Client.send_json(first, %{
        "type" => "command",
        "command_id" => "fanout-command-001",
        "name" => "raise_hand",
        "payload" => %{}
      })

    {:json, %{"type" => "ack", "result" => "committed", "revision" => 2}, first} =
      Client.recv(first)

    {:json, %{"type" => "event", "revision" => 2}, first} = Client.recv(first)
    {:json, %{"type" => "event", "revision" => 2}, second} = Client.recv(second)
    _closed = Client.close_tcp(first)

    second =
      Client.send_json(second, %{
        "type" => "command",
        "command_id" => "fanout-command-002",
        "name" => "lower_hand",
        "payload" => %{}
      })

    assert {:json, %{"type" => "ack", "result" => "committed", "revision" => 3}, second} =
             Client.recv(second)

    assert {:json, %{"type" => "event", "revision" => 3}, _second} = Client.recv(second)

    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert recovery.head.revision == 3
    assert hd(recovery.snapshot["participants"])["hand_raised"] == false
  end

  test "recovery becomes live only after the coordinator completes the barrier" do
    state = %{
      phase: :recovering,
      coordinator: self(),
      heartbeat_timer: nil,
      missed_heartbeats: 0
    }

    assert {:ok, live} = SocketV2.handle_info({:sync_recovery_live, self()}, state)

    assert live.phase == :live
    assert is_reference(live.heartbeat_timer)
    Process.cancel_timer(live.heartbeat_timer)
  end

  test "two missed live heartbeat deadlines close the socket" do
    state = %{
      phase: :live,
      heartbeat_timer: nil,
      missed_heartbeats: 0
    }

    assert {:ok, once_missed} = SocketV2.handle_info(:heartbeat_check, state)
    assert once_missed.missed_heartbeats == 1

    assert {:stop, :normal, {1001, "heartbeat timeout"}, closed} =
             SocketV2.handle_info(:heartbeat_check, once_missed)

    assert closed.heartbeat_timer == nil
  end

  defp hello(identity, cursor \\ nil) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 2,
      "token" => token,
      "streams" => %{"control" => %{"cursor" => cursor}}
    }
  end

  defp connect_live(port, identity) do
    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
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
