defmodule ChalkSync.Episodes.CoordinatorDiagnosticsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Operation

  @buffer __MODULE__.Buffer
  @diagnostic_record_limit 1_024

  setup do
    previous = Application.get_env(:chalk_sync, :episode_diagnostics)

    {:ok, buffer} =
      Buffer.start_link(name: @buffer, max_events: 10_000, max_bytes: 16 * 1024 * 1024)

    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :localhost, buffer: @buffer})

    on_exit(fn ->
      Application.put_env(:chalk_sync, :episode_diagnostics, previous)
      if Process.alive?(buffer), do: GenServer.stop(buffer)
    end)

    :ok
  end

  test "moderation target delivery and digest acknowledgement prove target application" do
    {initiating_participant, target} = seed_identities()
    {coordinator, recovery} = recover_live(target)

    assert {:ok, operation} =
             Operation.new("moderation-target-0001", :mute_participant, %{
               "participantId" => target.participant_id
             })

    assert {:ok, %{result: :pending, external_operation_id: external_operation_id}} =
             Memory.begin_operation(initiating_participant, operation)

    assert {:ok, claimed} = Memory.claim_operations(10)

    assert {_episode, %{external_operation_id: ^external_operation_id}} =
             Enum.find(claimed, fn {_episode, candidate} ->
               candidate.external_operation_id == external_operation_id
             end)

    assert {:ok, %{result: :applied, revision: revision}} =
             Memory.finalize_operation(
               initiating_participant.episode,
               external_operation_id,
               {:applied, :participant_microphone_stopped,
                %{"participant_id" => target.participant_id}}
             )

    assert {:ok, [event]} =
             Memory.recovery_page(
               initiating_participant.episode,
               recovery.head.revision,
               revision
             )

    assert :ok = Coordinator.publish(initiating_participant.episode, event)
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
    delivered = JSON.decode!(encoded)

    assert :ok =
             Coordinator.acknowledge(
               coordinator,
               delivered["revision"],
               delivered["resulting_state_digest"],
               self()
             )

    assert {:ok, scope, diagnostics} = Buffer.take_batch(@buffer)
    assert scope["participantId"] == target.participant_id

    assert Enum.map(diagnostics, fn %{event: diagnostic} ->
             {diagnostic["name"], diagnostic["expectation"]["checkpoint"]}
           end) == [
             {"moderation.microphone.disable", "target_delivery"},
             {"moderation.microphone.disable", "target_application"}
           ]
  end

  test "moderation records target unavailable when no target connection exists" do
    {initiating_participant, target} = seed_identities()
    assert {:ok, recovery} = Memory.recover(initiating_participant, nil)

    assert {:ok, _coordinator} =
             Coordinator.subscribe(initiating_participant, recovery.head, self())

    assert {:ok, operation} =
             Operation.new("moderation-target-0002", :stop_participant_camera, %{
               "participantId" => target.participant_id
             })

    assert {:ok, %{result: :pending, external_operation_id: external_operation_id}} =
             Memory.begin_operation(initiating_participant, operation)

    assert {:ok, _claimed} = Memory.claim_operations(10)

    assert {:ok, %{result: :applied, revision: revision}} =
             Memory.finalize_operation(
               initiating_participant.episode,
               external_operation_id,
               {:applied, :participant_camera_stopped,
                %{"participant_id" => target.participant_id}}
             )

    assert {:ok, [event]} =
             Memory.recovery_page(
               initiating_participant.episode,
               recovery.head.revision,
               revision
             )

    assert :ok = Coordinator.publish(initiating_participant.episode, event)
    assert {:ok, scope, [%{event: diagnostic}]} = Buffer.take_batch(@buffer)

    assert scope["participantId"] == target.participant_id
    assert diagnostic["name"] == "moderation.camera.disable"
    assert diagnostic["state"] == "not_observable"
    assert diagnostic["expectation"]["checkpoint"] == "target_application"
    assert diagnostic["attributes"]["target_state"] == "not_observable"
  end

  test "moderation target diagnostics dedupe across sockets and order cumulative acks" do
    {_initiating_participant, target} = seed_identities()
    {coordinator, recovery} = recover_live(target)

    socket_b =
      spawn(fn ->
        receive do
          :stop -> :ok
        end
      end)

    on_exit(fn ->
      if Process.alive?(socket_b), do: Process.exit(socket_b, :kill)
    end)

    assert {:ok, ^coordinator} = Coordinator.begin_recovery(target, socket_b)
    assert :ok = Coordinator.activate_recovery(coordinator, recovery, socket_b)
    assert {:ok, welcome_encoded, false} = Coordinator.pop(coordinator, socket_b)
    welcome = JSON.decode!(welcome_encoded)

    assert :ok =
             Coordinator.acknowledge_recovery(
               coordinator,
               welcome["recovery_id"],
               welcome["head"]["revision"],
               welcome["head"]["state_digest"],
               socket_b
             )

    assert {:ok, complete_encoded, false} = Coordinator.pop(coordinator, socket_b)
    assert %{"type" => "recovery_complete"} = JSON.decode!(complete_encoded)
    assert :ok = Coordinator.advance_recovery(coordinator, socket_b)

    first_digest = :crypto.hash(:sha256, "moderation-diagnostic-event-1")
    second_digest = :crypto.hash(:sha256, "moderation-diagnostic-event-2")

    first_revision = recovery.head.revision + 1
    second_revision = first_revision + 1

    first =
      diagnostic_event(
        first_revision,
        uuid(100),
        "participant_microphone_stopped",
        target.participant_id,
        first_digest,
        uuid(110)
      )

    second =
      diagnostic_event(
        second_revision,
        uuid(101),
        "participant_camera_stopped",
        target.participant_id,
        second_digest,
        uuid(111)
      )

    assert :ok = Coordinator.publish(target.episode, first)
    assert :ok = Coordinator.publish(target.episode, second)
    assert_receive {:sync_outbound_ready, ^coordinator}

    assert {:ok, first_encoded, false} = Coordinator.pop(coordinator, self())
    assert {:ok, second_encoded, false} = Coordinator.pop(coordinator, self())
    assert {:ok, _first_b, false} = Coordinator.pop(coordinator, socket_b)
    assert {:ok, _second_b, false} = Coordinator.pop(coordinator, socket_b)

    assert :ok =
             Coordinator.acknowledge(
               coordinator,
               second_revision,
               Base.encode16(second_digest, case: :lower),
               self()
             )

    assert :ok =
             Coordinator.acknowledge(
               coordinator,
               second_revision,
               Base.encode16(second_digest, case: :lower),
               socket_b
             )

    assert JSON.decode!(first_encoded)["revision"] == first_revision
    assert JSON.decode!(second_encoded)["revision"] == second_revision

    assert {:ok, scope, diagnostics} = Buffer.take_batch(@buffer)
    assert scope["participantId"] == target.participant_id

    assert Enum.map(diagnostics, fn %{event: diagnostic} ->
             {diagnostic["name"], diagnostic["expectation"]["checkpoint"]}
           end) == [
             {"moderation.microphone.disable", "target_delivery"},
             {"moderation.camera.disable", "target_delivery"},
             {"moderation.microphone.disable", "target_application"},
             {"moderation.camera.disable", "target_application"}
           ]
  end

  test "diagnostic stage dedupe retention stays bounded and preserves recent order" do
    {_initiating_participant, target} = seed_identities()
    {coordinator, recovery} = recover_live(target)
    count = @diagnostic_record_limit + 8

    events =
      Enum.map(1..count, fn offset ->
        digest = :crypto.hash(:sha256, "bounded-moderation-event-#{offset}")
        revision = recovery.head.revision + offset

        name =
          if rem(offset, 2) == 0,
            do: "participant_camera_stopped",
            else: "participant_microphone_stopped"

        diagnostic_event(
          revision,
          uuid(100_000 + offset),
          name,
          target.participant_id,
          digest,
          uuid(200_000 + offset)
        )
      end)

    Enum.each(events, fn event ->
      assert :ok = Coordinator.publish(target.episode, event)
      assert_receive {:sync_outbound_ready, ^coordinator}
      assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
      delivered = JSON.decode!(encoded)

      assert :ok =
               Coordinator.acknowledge(
                 coordinator,
                 delivered["revision"],
                 delivered["resulting_state_digest"],
                 self()
               )
    end)

    state = :sys.get_state(coordinator)

    for stage <- [:delivery, :application] do
      records = state.diagnostic_records[stage]
      assert MapSet.size(records.keys) == @diagnostic_record_limit
      assert :queue.len(records.order) == @diagnostic_record_limit
    end

    assert MapSet.size(state.diagnostic_records.unavailable.keys) == 0

    latest_operation_ref = uuid(200_000 + count)

    assert {:ok, _scope, diagnostics} = Buffer.take_batch(@buffer, 10_000, 16 * 1024 * 1024)

    recent =
      diagnostics
      |> Enum.map(& &1.event)
      |> Enum.filter(&(&1["producerOperationRef"] == latest_operation_ref))

    assert Enum.map(recent, fn event ->
             {event["name"], event["expectation"]["checkpoint"]}
           end) == [
             {"moderation.camera.disable", "target_delivery"},
             {"moderation.camera.disable", "target_application"}
           ]
  end

  defp recover_live(identity) do
    assert {:ok, recovery} = Memory.recover(identity, nil)
    assert {:ok, coordinator} = Coordinator.begin_recovery(identity, self())
    assert :ok = Coordinator.activate_recovery(coordinator, recovery, self())
    assert_receive {:sync_outbound_ready, ^coordinator}
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())
    welcome = JSON.decode!(encoded)

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
    {coordinator, recovery}
  end

  defp seed_identities do
    suffix = System.unique_integer([:positive, :monotonic])

    episode = %EpisodeKey{
      tenant_id: uuid(suffix),
      space_id: uuid(suffix + 1),
      episode_id: uuid(suffix + 2)
    }

    initiating_participant = identity(episode, suffix + 3, suffix + 5, ["muteOthers"])
    target = identity(episode, suffix + 4, suffix + 6, ["subscribe"])

    assert :ok =
             Memory.seed_episode(episode, [
               participant(initiating_participant, "Owner", "owner"),
               participant(target, "Observer", "observer")
             ])

    {initiating_participant, target}
  end

  defp identity(episode, participant_suffix, intent_suffix, capabilities) do
    %Identity{
      episode: episode,
      participant_id: uuid(participant_suffix),
      participant_generation: 1,
      admission_lifecycle_intent_id: uuid(intent_suffix),
      capabilities: capabilities
    }
  end

  defp participant(identity, display_name, role) do
    %{
      id: identity.participant_id,
      generation: identity.participant_generation,
      display_name: display_name,
      role: role,
      admission_lifecycle_intent_id: identity.admission_lifecycle_intent_id
    }
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")
    "018f2f65-2a77-4a44-8e9a-#{suffix}"
  end

  defp diagnostic_event(revision, event_id, name, participant_id, digest, command_id) do
    %{
      event_id: event_id,
      base_revision: revision - 1,
      revision: revision,
      schema_version: 1,
      resulting_state_digest: digest,
      name: name,
      payload: %{"participant_id" => participant_id},
      external_operation_id: command_id
    }
  end
end
