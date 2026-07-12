defmodule ChalkSync.Sessions.CoordinatorTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey

  test "authoritative repair heals a completely lost fanout hint" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.subscribe(identity, recovery.head, self())

    {:ok, command} = Command.new("repair-command-001", :raise_hand, %{})
    assert {:ok, decision} = Memory.decide_command(identity, command)

    send(coordinator, :repair_now)
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
    assert {:ok, %{"type" => "event", "revision" => 2}} = JSON.decode(encoded)

    assert :ok = Coordinator.publish(identity.session, decision.event)
    refute_receive {:sync_outbound_ready, ^coordinator}, 25
  end

  test "duplicate, delayed, and reordered head hints deliver one exact suffix" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.subscribe(identity, recovery.head, self())

    {:ok, first} = Command.new("hint-order-command1", :raise_hand, %{})
    {:ok, second} = Command.new("hint-order-command2", :lower_hand, %{})
    assert {:ok, %{revision: 2}} = Memory.decide_command(identity, first)
    assert {:ok, %{revision: 3}} = Memory.decide_command(identity, second)

    Coordinator.hint(identity.session, 3)
    Coordinator.hint(identity.session, 2)
    Coordinator.hint(identity.session, 3)

    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded_first, false} = Coordinator.pop(coordinator, self())
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded_second, false} = Coordinator.pop(coordinator, self())
    assert [2, 3] == Enum.map([encoded_first, encoded_second], &JSON.decode!(&1)["revision"])
    assert Coordinator.pop(coordinator, self()) == :empty

    Coordinator.hint(identity.session, 2)
    Coordinator.hint(identity.session, 3)
    refute_receive {:sync_outbound_ready, ^coordinator}, 25
  end

  test "a non-reading socket is cut off at 256 events without slowing a reader or commits" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.subscribe(identity, recovery.head, self())

    parent = self()

    fast =
      spawn(fn ->
        fast_reader(parent, coordinator)
      end)

    assert {:ok, ^coordinator} = Coordinator.subscribe(identity, recovery.head, fast)

    Enum.each(1..257, fn index ->
      name = if(rem(index, 2) == 1, do: :raise_hand, else: :lower_hand)
      command_id = "slow-peer-#{String.pad_leading(Integer.to_string(index), 7, "0")}"
      {:ok, command} = Command.new(command_id, name, %{})

      assert {:ok, decision} = Memory.decide_command(identity, command)
      assert :ok = Coordinator.publish(identity.session, decision.event)
      assert_receive {:fast_revision, revision}
      assert revision == index + 1
    end)

    assert_receive {:sync_outbound_overflow, :event_limit, 1}
    assert Process.alive?(coordinator)

    assert {:ok, authoritative} = Memory.recover(identity, nil)
    assert authoritative.head.revision == 258
    assert hd(authoritative.snapshot["participants"])["hand_raised"]

    send(fast, :stop)
  end

  test "drain preserves queued order and closes after the final reserved frame" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.subscribe(identity, recovery.head, self())

    {:ok, command} = Command.new("drain-event-cmd01", :raise_hand, %{})
    assert {:ok, decision} = Memory.decide_command(identity, command)
    assert :ok = Coordinator.publish(identity.session, decision.event)

    GenServer.cast(coordinator, :drain)
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
    assert {:ok, %{"revision" => 2, "resulting_state_digest" => digest}} = JSON.decode(encoded)
    assert :ok = Coordinator.acknowledge(coordinator, 2, digest, self())
    assert_receive {:sync_server_drained, ^coordinator}
  end

  test "snapshot recovery retains its frame and advances only after the exact ACK" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.begin_recovery(identity, self())
    assert :ok = Coordinator.activate_recovery(coordinator, recovery, self())

    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
    welcome = JSON.decode!(encoded)
    refute_receive {:sync_outbound_ready, ^coordinator}, 25
    assert :empty = Coordinator.pop(coordinator, self())

    assert :ok =
             Coordinator.acknowledge_recovery(
               coordinator,
               welcome["recovery_id"],
               welcome["head"]["revision"],
               welcome["head"]["state_digest"],
               self()
             )

    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, complete, false} = Coordinator.pop(coordinator, self())
    assert %{"type" => "recovery_complete"} = JSON.decode!(complete)
    assert_receive {:sync_recovery_advance, ^coordinator}
    assert :ok = Coordinator.advance_recovery(coordinator, self())
    assert_receive {:sync_recovery_live, ^coordinator}
  end

  test "replay does not fetch or enqueue the next page before the exact page ACK" do
    identity = seed_identity()
    assert {:ok, initial} = Memory.recover(identity, nil)

    Enum.each(1..129, fn index ->
      name = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand
      command_id = "recovery-page-#{String.pad_leading(to_string(index), 4, "0")}"
      assert {:ok, command} = Command.new(command_id, name, %{})
      assert {:ok, _decision} = Memory.decide_command(identity, command)
    end)

    assert {:ok, %{mode: :replay} = recovery} = Memory.recover(identity, initial.head)
    assert {:ok, coordinator} = Coordinator.begin_recovery(identity, self())
    assert :ok = Coordinator.activate_recovery(coordinator, recovery, self())
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, welcome, false} = Coordinator.pop(coordinator, self())
    assert %{"type" => "welcome", "mode" => "replay"} = JSON.decode!(welcome)
    assert_receive {:sync_recovery_advance, ^coordinator}
    assert :ok = Coordinator.advance_recovery(coordinator, self())

    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, first_encoded, false} = Coordinator.pop(coordinator, self())
    first = JSON.decode!(first_encoded)
    assert first["last_revision"] == 129
    refute_receive {:sync_outbound_ready, ^coordinator}, 25
    assert :empty = Coordinator.pop(coordinator, self())

    assert :ok =
             Coordinator.acknowledge_recovery(
               coordinator,
               first["recovery_id"],
               first["last_revision"],
               List.last(first["events"])["resulting_state_digest"],
               self()
             )

    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, second_encoded, false} = Coordinator.pop(coordinator, self())
    assert %{"first_revision" => 130, "last_revision" => 130} = JSON.decode!(second_encoded)
  end

  test "wrong recovery ID, revision, or digest fails recovery closed" do
    Enum.each([:recovery_id, :revision, :state_digest], fn mismatch ->
      identity = seed_identity()
      assert {:ok, recovery} = Memory.recover(identity, nil)
      assert {:ok, coordinator} = Coordinator.begin_recovery(identity, self())
      assert :ok = Coordinator.activate_recovery(coordinator, recovery, self())
      assert_receive {:sync_outbound_ready, ^coordinator}
      assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
      welcome = JSON.decode!(encoded)

      ack = %{
        recovery_id: welcome["recovery_id"],
        revision: welcome["head"]["revision"],
        state_digest: welcome["head"]["state_digest"]
      }

      invalid =
        case mismatch do
          :recovery_id -> %{ack | recovery_id: uuid(900_000)}
          :revision -> %{ack | revision: ack.revision + 1}
          :state_digest -> %{ack | state_digest: String.duplicate("0", 64)}
        end

      assert {:error, :invalid_recovery_ack} =
               Coordinator.acknowledge_recovery(
                 coordinator,
                 invalid.recovery_id,
                 invalid.revision,
                 invalid.state_digest,
                 self()
               )

      assert_receive {:sync_outbound_overflow, :invalid_recovery_ack, 0}
      assert {:error, :not_subscribed} = Coordinator.pop(coordinator, self())
    end)
  end

  @tag timeout: 8_000
  test "an unacknowledged recovery frame expires near five seconds while a healthy peer continues" do
    identity = seed_identity()
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.begin_recovery(identity, self())
    assert :ok = Coordinator.activate_recovery(coordinator, recovery, self())
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, _encoded, false} = Coordinator.pop(coordinator, self())

    parent = self()
    fast = spawn(fn -> fast_reader(parent, coordinator) end)
    assert {:ok, ^coordinator} = Coordinator.subscribe(identity, recovery.head, fast)

    started_at = System.monotonic_time(:millisecond)
    assert_receive {:sync_outbound_overflow, :age_limit, 0}, 6_500
    elapsed = System.monotonic_time(:millisecond) - started_at
    assert elapsed >= 4_500
    assert elapsed <= 6_500
    assert Process.alive?(coordinator)

    {:ok, command} = Command.new("healthy-after-recovery-timeout", :raise_hand, %{})
    assert {:ok, decision} = Memory.decide_command(identity, command)
    assert :ok = Coordinator.publish(identity.session, decision.event)
    assert_receive {:fast_revision, 2}
    send(fast, :stop)
  end

  defp fast_reader(parent, coordinator) do
    receive do
      {:sync_outbound_ready, ^coordinator} ->
        case Coordinator.pop(coordinator, self()) do
          {:ok, encoded, false} ->
            {:ok, event} = JSON.decode(encoded)

            :ok =
              Coordinator.acknowledge(
                coordinator,
                event["revision"],
                event["resulting_state_digest"],
                self()
              )

            send(parent, {:fast_revision, event["revision"]})
            fast_reader(parent, coordinator)

          other ->
            send(parent, {:fast_error, other})
        end

      :stop ->
        :ok

      _other ->
        fast_reader(parent, coordinator)
    end
  end

  defp seed_identity do
    suffix = System.unique_integer([:positive, :monotonic])

    identity = %Identity{
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

    identity
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")
    "018f2f65-2a77-4a44-8e9a-#{suffix}"
  end
end
