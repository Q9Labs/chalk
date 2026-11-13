defmodule ChalkSync.RecordingFoundationTest do
  use ChalkSync.PostgresCase, async: false

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  setup %{connection: connection} do
    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [identity] = fixture.identities
    %{episode: fixture.episode, identity: identity, recording_id: UUID.generate()}
  end

  test "a provider start acknowledgement keeps a manual Recording starting", context do
    {:ok, operation} =
      Operation.new("manual_recording_start_01", :start_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :pending} = pending} =
             Postgres.begin_operation(context.identity, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)

    assert recovery.snapshot["recording"] == %{
             "recording_id" => context.recording_id,
             "status" => "starting",
             "failure_code" => nil
           }
  end

  test "a stop is rejected until the matching Recording is active", context do
    {:ok, stop} =
      Operation.new("inactive_recording_stop", :stop_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :rejected, reason: :invalid_target}} =
             Postgres.begin_operation(context.identity, stop)
  end

  test "capture readiness is fenced to the acknowledged start and idempotently records",
       context do
    {:ok, start} =
      Operation.new("fenced_recording_start", :start_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :pending} = pending_start} =
             Postgres.begin_operation(context.identity, start)

    {:ok, ready_before_ack} =
      Operation.recording_capture_ready(
        "capture_ready_before_ack",
        context.recording_id,
        pending_start.external_operation_id,
        1
      )

    assert {:error, :stale_recording_fence} =
             Postgres.begin_internal_operation(context.episode, ready_before_ack)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready} =
      Operation.recording_capture_ready(
        "capture_ready_after_ack",
        context.recording_id,
        pending_start.external_operation_id,
        1
      )

    assert {:ok, %{result: :pending} = pending_ready} =
             Postgres.begin_internal_operation(context.episode, ready)

    assert {:ok, %{result: :applied, revision: revision}} =
             Postgres.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: ^revision}} =
             Postgres.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "recording"
  end

  test "a newer capture epoch fences an older readiness retry", context do
    {:ok, start} =
      Operation.new("epoch_fenced_recording_start", :start_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :pending} = pending_start} =
             Postgres.begin_operation(context.identity, start)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready_epoch_one} =
      Operation.recording_capture_ready(
        "capture_ready_epoch_one",
        context.recording_id,
        pending_start.external_operation_id,
        1
      )

    {:ok, ready_epoch_two} =
      Operation.recording_capture_ready(
        "capture_ready_epoch_two",
        context.recording_id,
        pending_start.external_operation_id,
        2
      )

    assert {:ok, %{result: :pending} = pending_epoch_one} =
             Postgres.begin_internal_operation(context.episode, ready_epoch_one)

    assert {:ok, %{result: :pending} = pending_epoch_two} =
             Postgres.begin_internal_operation(context.episode, ready_epoch_two)

    assert {:error, :stale_recording_fence} =
             Postgres.finalize_operation(
               context.episode,
               pending_epoch_one.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_epoch_two.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "recording"
  end

  test "stop acknowledgement accepts a recovered capture epoch and fences an older callback",
       context do
    {:ok, start} =
      Operation.new("stop_completion_recording_start", :start_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :pending} = pending_start} =
             Postgres.begin_operation(context.identity, start)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_start.external_operation_id,
               {:confirmed, :recording}
             )

    {:ok, ready} =
      Operation.recording_capture_ready(
        "stop_completion_capture_ready",
        context.recording_id,
        pending_start.external_operation_id,
        3
      )

    assert {:ok, %{result: :pending} = pending_ready} =
             Postgres.begin_internal_operation(context.episode, ready)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_ready.external_operation_id,
               {:confirmed, :local}
             )

    {:ok, stop} =
      Operation.new("stop_completion_recording_stop", :stop_recording, %{
        "recordingId" => context.recording_id
      })

    assert {:ok, %{result: :pending} = pending_stop} =
             Postgres.begin_operation(context.identity, stop)

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopping"

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending_stop.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopping"

    {:ok, stale_completion} =
      Operation.recording_capture_stopped(
        "stop_completion_stale_epoch",
        context.recording_id,
        pending_stop.external_operation_id,
        2
      )

    assert {:error, :stale_recording_fence} =
             Postgres.begin_internal_operation(context.episode, stale_completion)

    {:ok, completion} =
      Operation.recording_capture_stopped(
        "stop_completion_capture_stopped",
        context.recording_id,
        pending_stop.external_operation_id,
        4
      )

    assert {:ok, %{result: :pending} = pending_completion} =
             Postgres.begin_internal_operation(context.episode, completion)

    assert {:ok, %{result: :applied, revision: revision}} =
             Postgres.finalize_operation(
               context.episode,
               pending_completion.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: ^revision}} =
             Postgres.finalize_operation(
               context.episode,
               pending_completion.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "stopped"
  end

  test "automatic start uses authenticated system authority without a Participant", context do
    {:ok, operation} =
      Operation.system_recording_start("automatic_recording_01", context.recording_id, 7)

    assert {:ok, %{result: :pending} = pending} =
             Postgres.begin_internal_operation(context.episode, operation)

    assert {:ok, %{result: :pending, delivery: :duplicate, external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(context.episode, operation)

    assert pending.external_operation_id == operation_id

    assert {:ok, stored} = Postgres.read_operation(context.episode, pending.external_operation_id)
    assert stored.actor_kind == "system"
    assert stored.actor_id == "recording_policy"
    assert stored.actor_participant_id == nil

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               context.episode,
               pending.external_operation_id,
               {:confirmed, :recording}
             )

    assert {:ok, recovery} = Postgres.recover(context.identity, nil)
    assert recovery.snapshot["recording"]["status"] == "starting"
    assert [%{"participant_id" => host_id}] = recovery.snapshot["participants"]
    assert host_id == context.identity.participant_id
  end
end
