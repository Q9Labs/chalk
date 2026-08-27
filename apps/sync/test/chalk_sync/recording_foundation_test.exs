defmodule ChalkSync.RecordingFoundationTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Operation

  @tenant "11111111-1111-4111-8111-111111111111"
  @space "22222222-2222-4222-8222-222222222222"
  @episode_id "33333333-3333-4333-8333-333333333333"
  @host "55555555-5555-4555-8555-555555555555"
  @recording_id "77777777-7777-4777-8777-777777777777"

  setup do
    Memory.reset()
    episode = %EpisodeKey{tenant_id: @tenant, space_id: @space, episode_id: @episode_id}

    :ok =
      Memory.seed_episode(episode, [
        %{id: @host, generation: 1, display_name: "Host", role: "owner"}
      ])

    %{
      episode: episode,
      identity: %Identity{episode: episode, participant_id: @host, participant_generation: 1}
    }
  end

  test "a provider start acknowledgement keeps a manual Recording starting", context do
    {:ok, operation} =
      Operation.new("manual_recording_start_01", :start_recording, %{
        "recordingId" => @recording_id
      })

    assert {:ok, %{result: :pending} = pending} =
             Memory.begin_operation(context.identity, operation)

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)

    assert recovery.snapshot["recording"] == %{
             "recording_id" => @recording_id,
             "status" => "starting",
             "failure_code" => nil
           }
  end

  test "a stop is rejected until the matching Recording is active", context do
    {:ok, stop} =
      Operation.new("inactive_recording_stop", :stop_recording, %{
        "recordingId" => @recording_id
      })

    assert {:ok, %{result: :rejected, reason: :invalid_state}} =
             Memory.begin_operation(context.identity, stop)
  end

  test "capture readiness is fenced to the acknowledged start and idempotently records",
       context do
    {:ok, start} =
      Operation.new("fenced_recording_start", :start_recording, %{"recordingId" => @recording_id})

    assert {:ok, %{result: :pending} = pending_start} =
             Memory.begin_operation(context.identity, start)

    {:ok, ready_before_ack} =
      Operation.recording_capture_ready(
        "capture_ready_before_ack",
        @recording_id,
        pending_start.external_operation_id,
        1
      )

    assert {:error, :stale_recording_fence} =
             Memory.begin_internal_operation(context.episode, ready_before_ack)

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready} =
      Operation.recording_capture_ready(
        "capture_ready_after_ack",
        @recording_id,
        pending_start.external_operation_id,
        1
      )

    assert {:ok, %{result: :pending} = pending_ready} =
             Memory.begin_internal_operation(context.episode, ready)

    assert {:ok, %{result: :applied, revision: revision}} =
             Memory.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: ^revision}} =
             Memory.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "recording"
  end

  test "a newer capture epoch fences an older readiness retry", context do
    {:ok, start} =
      Operation.new("epoch_fenced_recording_start", :start_recording, %{
        "recordingId" => @recording_id
      })

    assert {:ok, %{result: :pending} = pending_start} =
             Memory.begin_operation(context.identity, start)

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready_epoch_one} =
      Operation.recording_capture_ready(
        "capture_ready_epoch_one",
        @recording_id,
        pending_start.external_operation_id,
        1
      )

    {:ok, ready_epoch_two} =
      Operation.recording_capture_ready(
        "capture_ready_epoch_two",
        @recording_id,
        pending_start.external_operation_id,
        2
      )

    assert {:ok, %{result: :pending} = pending_epoch_one} =
             Memory.begin_internal_operation(context.episode, ready_epoch_one)

    assert {:ok, %{result: :pending} = pending_epoch_two} =
             Memory.begin_internal_operation(context.episode, ready_epoch_two)

    assert {:error, :stale_recording_fence} =
             Memory.finalize_operation(
               context.episode,
               pending_epoch_one.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_epoch_two.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "recording"
  end

  test "stop acknowledgement leaves stopping until fenced capture completion", context do
    {:ok, start} =
      Operation.new("stop_completion_recording_start", :start_recording, %{
        "recordingId" => @recording_id
      })

    assert {:ok, %{result: :pending} = pending_start} =
             Memory.begin_operation(context.identity, start)

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready} =
      Operation.recording_capture_ready(
        "stop_completion_capture_ready",
        @recording_id,
        pending_start.external_operation_id,
        3
      )

    assert {:ok, %{result: :pending} = pending_ready} =
             Memory.begin_internal_operation(context.episode, ready)

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    {:ok, stop} =
      Operation.new("stop_completion_recording_stop", :stop_recording, %{
        "recordingId" => @recording_id
      })

    assert {:ok, %{result: :pending} = pending_stop} =
             Memory.begin_operation(context.identity, stop)

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopping"

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending_stop.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopping"

    {:ok, stale_completion} =
      Operation.recording_capture_stopped(
        "stop_completion_stale_epoch",
        @recording_id,
        pending_stop.external_operation_id,
        2
      )

    assert {:error, :stale_recording_fence} =
             Memory.begin_internal_operation(context.episode, stale_completion)

    {:ok, completion} =
      Operation.recording_capture_stopped(
        "stop_completion_capture_stopped",
        @recording_id,
        pending_stop.external_operation_id,
        3
      )

    assert {:ok, %{result: :pending} = pending_completion} =
             Memory.begin_internal_operation(context.episode, completion)

    assert {:ok, %{result: :applied, revision: revision}} =
             Memory.finalize_operation(
               context.episode,
               pending_completion.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: ^revision}} =
             Memory.finalize_operation(
               context.episode,
               pending_completion.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopped"
  end

  test "automatic start uses authenticated system authority without a Participant", context do
    {:ok, operation} =
      Operation.system_recording_start("automatic_recording_01", @recording_id, 7)

    assert {:ok, %{result: :pending} = pending} =
             Memory.begin_internal_operation(context.episode, operation)

    assert {:ok, %{result: :pending, delivery: :duplicate, external_operation_id: operation_id}} =
             Memory.begin_internal_operation(context.episode, operation)

    assert pending.external_operation_id == operation_id

    assert {:ok, stored} = Memory.read_operation(context.episode, pending.external_operation_id)
    assert stored.actor_kind == "system"
    assert stored.actor_id == "recording_policy"
    assert stored.actor_participant_id == nil

    assert {:ok, %{result: :applied}} =
             Memory.finalize_operation(
               context.episode,
               pending.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Memory.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "starting"
    assert [%{"participant_id" => @host}] = recovery.snapshot["participants"]
  end
end
