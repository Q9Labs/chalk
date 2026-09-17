defmodule ChalkSync.Stateholder.PostgresLifecycleTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  test "an authoritative Participant join atomically queues one automatic Recording", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection, artifact_policy("automatic"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    assert [["joining", "pending", 0, 0, 0]] = recording_activation_rows(fixture)

    assert {:ok,
            %{
              result: :applied,
              event: %{name: "participant_joined", revision: 1}
            }} = Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert [
             [
               "active",
               "applied",
               2,
               request_key,
               "start_recording",
               nil,
               "system",
               "recording_policy",
               2,
               "pending",
               operation_recording_id,
               recording_id,
               "starting",
               nil
             ]
           ] = automatic_recording_rows(fixture)

    assert request_key ==
             "automatic_recording_" <> String.replace(fixture.episode.episode_id, "-", "")

    assert operation_recording_id == recording_id
    assert {:ok, _recording_id} = UUID.load(recording_id)

    assert {:ok, %{result: :already_applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert [["active", "applied", 2, 1, 1]] = recording_activation_rows(fixture)
  end

  test "automatic Recording acceptance rolls back with Participant activation and retries once",
       %{
         connections: connections
       } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection, artifact_policy("automatic"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Application.put_env(:chalk_sync, :lifecycle_fault_hook, fn point, _context ->
      if point == :after_automatic_recording_acceptance,
        do: raise("injected automatic Recording rollback")
    end)

    try do
      assert {:retryable, :decision_unavailable} =
               Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)
    after
      Application.delete_env(:chalk_sync, :lifecycle_fault_hook)
    end

    assert [["joining", "pending", 0, 0, 0]] = recording_activation_rows(fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert [["active", "applied", 2, 1, 1]] = recording_activation_rows(fixture)
  end

  test "a later Participant join does not restart a failed automatic Recording", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection, artifact_policy("automatic"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    [[operation_id]] =
      query_rows(
        fixture,
        """
        select external_operation_id
        from sync_external_operations
        where tenant_id = $1 and episode_id = $2 and operation_name = 'start_recording'
        """,
        []
      )

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(
               fixture.episode,
               UUID.load!(operation_id),
               {:failed, :recording_provider_unavailable}
             )

    pending =
      fixture
      |> Map.put(:state, nil)
      |> then(&SyncPostgres.seed_admission_request(connection, &1, request_status: :pending))

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(
               fixture.episode,
               pending.admission_requested_intent_id
             )

    assert {:ok, %{result: :applied, event: %{name: "participant_joined"}}} =
             Postgres.apply_lifecycle_intent(
               fixture.episode,
               pending.admission_join_intent_id
             )

    assert [["active", "applied", 5, 1, 1]] = recording_activation_rows(fixture)

    assert [["failed", "failed"]] =
             query_rows(
               fixture,
               """
               select operation.status, recording.status
               from sync_external_operations operation
               join sync_recordings recording
                 on recording.tenant_id = operation.tenant_id
                 and recording.episode_id = operation.episode_id
                 and recording.recording_id = operation.recording_id
               where operation.tenant_id = $1 and operation.episode_id = $2
                 and operation.operation_name = 'start_recording'
               """,
               []
             )
  end

  test "trusted capture readiness advances the epoch only after its Recording start applies", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = UUID.generate()

    {:ok, start} =
      Operation.new("trusted_ready_start_0001", :start_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: start_operation_id}} =
             Postgres.begin_operation(hd(fixture.identities), start)

    ready_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        "trusted_capture_ready_0001",
        recording_id,
        start_operation_id,
        1
      )

    assert {:error, :stale_recording_fence} =
             Postgres.finalize_operation(
               fixture.episode,
               ready_operation_id,
               {:confirmed, :local}
             )

    assert [["pending", "starting", 0]] =
             recording_capture_rows(fixture, ready_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               start_operation_id,
               {:confirmed, :recording}
             )

    wrong_start_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        "trusted_capture_wrong_start",
        recording_id,
        UUID.generate(),
        1
      )

    assert {:error, :stale_recording_fence} =
             Postgres.finalize_operation(
               fixture.episode,
               wrong_start_operation_id,
               {:confirmed, :local}
             )

    assert [["pending", "starting", 0]] =
             recording_capture_rows(fixture, wrong_start_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               ready_operation_id,
               {:confirmed, :local}
             )

    assert [["applied", "recording", 1]] =
             recording_capture_rows(fixture, ready_operation_id)
  end

  test "trusted stale readiness is rejected without blocking an internally prepared callback", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = UUID.generate()

    {:ok, start} =
      Operation.new("stale_ready_start_0001", :start_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: start_operation_id}} =
             Postgres.begin_operation(hd(fixture.identities), start)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               start_operation_id,
               {:confirmed, :recording}
             )

    {:ok, internal_ready} =
      Operation.recording_capture_ready(
        "internal_capture_ready_epoch_2",
        recording_id,
        start_operation_id,
        2
      )

    assert {:ok, %{external_operation_id: internal_ready_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, internal_ready)

    stale_ready_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        "trusted_capture_stale_epoch",
        recording_id,
        start_operation_id,
        1
      )

    assert {:error, :stale_recording_fence} =
             Postgres.finalize_operation(
               fixture.episode,
               stale_ready_operation_id,
               {:confirmed, :local}
             )

    assert [["pending", "starting", 2]] =
             recording_capture_rows(fixture, stale_ready_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               internal_ready_operation_id,
               {:confirmed, :local}
             )

    assert [["applied", "recording", 2]] =
             recording_capture_rows(fixture, internal_ready_operation_id)
  end

  test "cold expiry waits for a pending Recording start and a late acknowledgement cannot resurrect it",
       %{
         connections: connections
       } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = UUID.generate()

    {:ok, start} =
      Operation.new("cold_expiry_start_0001", :start_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: start_operation_id}} =
             Postgres.begin_operation(hd(fixture.identities), start)

    failure_operation_id =
      insert_trusted_capture_failure(
        connection,
        fixture,
        "cold_expiry_failure_0001",
        recording_id,
        start_operation_id
      )

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, failure_operation} =
             Enum.find(claimed, fn {_episode, candidate} ->
               candidate.external_operation_id == failure_operation_id
             end)

    assert :finalization_failure =
             ExternalOperationConsumer.execute_operation(
               episode,
               failure_operation,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert [["pending", "pending", "starting", nil, "starting", nil, 0]] =
             recording_failure_rows(fixture, failure_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               start_operation_id,
               {:confirmed, :recording}
             )

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               failure_operation,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert [
             [
               "applied",
               "applied",
               "failed",
               "capture_reservation_expired",
               "failed",
               "capture_reservation_expired",
               1
             ]
           ] = recording_failure_rows(fixture, failure_operation_id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(
               fixture.episode,
               start_operation_id,
               {:confirmed, :recording}
             )

    assert [
             [
               "applied",
               "applied",
               "failed",
               "capture_reservation_expired",
               "failed",
               "capture_reservation_expired",
               1
             ]
           ] = recording_failure_rows(fixture, failure_operation_id)
  end

  test "capture failure terminals every active Recording state and fences late callbacks", %{
    connections: connections
  } do
    connection = hd(connections)

    Enum.each(["starting", "recording", "stopping"], fn active_status ->
      fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      recording_id = UUID.generate()

      {:ok, start} =
        Operation.new("active_failure_#{active_status}_start", :start_recording, %{
          "recordingId" => recording_id
        })

      assert {:ok, %{external_operation_id: start_operation_id}} =
               Postgres.begin_operation(hd(fixture.identities), start)

      assert {:ok, %{result: :applied}} =
               Postgres.finalize_operation(
                 fixture.episode,
                 start_operation_id,
                 {:confirmed, :recording}
               )

      {late_ready_operation_id, stop_operation_id, late_stopped_operation_id} =
        prepare_active_recording_state(
          connection,
          fixture,
          active_status,
          recording_id,
          start_operation_id
        )

      failure_code =
        if active_status == "stopping",
          do: "capture_stopped_before_completion",
          else: "capture_attempt_failed"

      failure_operation_id =
        insert_trusted_capture_failure(
          connection,
          fixture,
          "active_failure_#{active_status}_terminal",
          recording_id,
          start_operation_id,
          failure_code
        )

      assert {:ok, %{result: :applied}} =
               Postgres.finalize_operation(
                 fixture.episode,
                 failure_operation_id,
                 {:confirmed, :local}
               )

      assert [
               [
                 "applied",
                 "applied",
                 "failed",
                 ^failure_code,
                 "failed",
                 ^failure_code,
                 1
               ]
             ] = recording_failure_rows(fixture, failure_operation_id)

      assert {:ok, %{result: :applied, delivery: :duplicate}} =
               Postgres.finalize_operation(
                 fixture.episode,
                 failure_operation_id,
                 {:confirmed, :local}
               )

      if late_ready_operation_id do
        assert {:error, :stale_recording_fence} =
                 Postgres.finalize_operation(
                   fixture.episode,
                   late_ready_operation_id,
                   {:confirmed, :local}
                 )
      end

      if stop_operation_id do
        assert {:ok, %{result: :applied}} =
                 Postgres.finalize_operation(
                   fixture.episode,
                   stop_operation_id,
                   {:confirmed, :recording}
                 )
      end

      if late_stopped_operation_id do
        assert {:error, :stale_recording_fence} =
                 Postgres.finalize_operation(
                   fixture.episode,
                   late_stopped_operation_id,
                   {:confirmed, :local}
                 )
      end

      assert [
               [
                 "applied",
                 "applied",
                 "failed",
                 ^failure_code,
                 "failed",
                 ^failure_code,
                 1
               ]
             ] = recording_failure_rows(fixture, failure_operation_id)
    end)
  end

  test "capture stopped accepts a recovered epoch while fencing an older callback", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = activate_recording(connection, fixture, "recovered_stop", 2)

    {:ok, stop} =
      Operation.new("recovered_stop_recording", :stop_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: stop_operation_id}} =
             Postgres.begin_operation(hd(fixture.identities), stop)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               stop_operation_id,
               {:confirmed, :recording}
             )

    {:ok, stale_stopped} =
      Operation.recording_capture_stopped(
        "recovered_stop_stale_epoch",
        recording_id,
        stop_operation_id,
        1
      )

    assert {:error, :stale_recording_fence} =
             Postgres.begin_internal_operation(fixture.episode, stale_stopped)

    {:ok, stopped} =
      Operation.recording_capture_stopped(
        "recovered_stop_current_epoch",
        recording_id,
        stop_operation_id,
        3
      )

    assert {:ok, %{external_operation_id: stopped_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, stopped)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               stopped_operation_id,
               {:confirmed, :local}
             )

    assert [["applied", "applied", "stop_recording", "stopped", "active", "stopped", 2, 1]] =
             recording_stop_rows(fixture, stopped_operation_id, stop_operation_id)
  end

  test "capture deadline stops an active Recording only under the scoped reservation and epoch",
       %{
         connections: connections
       } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    recording_id = activate_recording(connection, fixture, "deadline_stop", 2)
    recording_uuid = UUID.dump!(recording_id)
    reservation_uuid = UUID.dump!(UUID.generate())
    tenant_uuid = UUID.dump!(fixture.episode.tenant_id)

    scope = [
      tenant_uuid,
      UUID.dump!(fixture.episode.space_id),
      UUID.dump!(fixture.episode.episode_id)
    ]

    on_exit(fn ->
      Postgrex.query!(connection, "delete from recording_pipelines where recording_id = $1", [
        recording_uuid
      ])

      Postgrex.query!(connection, "delete from recording_reservations where recording_id = $1", [
        recording_uuid
      ])

      Postgrex.query!(connection, "delete from recordings where id = $1", [recording_uuid])
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    Postgrex.query!(
      connection,
      """
      insert into recordings(tenant_id, space_id, episode_id, id, status, storage_provider)
      values($1, $2, $3, $4, 'processing', 'cf')
      """,
      scope ++ [recording_uuid]
    )

    future_deadline = System.system_time(:millisecond) + 3_600_000

    Postgrex.query!(
      connection,
      """
      insert into recording_reservations(tenant_id, space_id, episode_id, recording_id, id,
        idempotency_key, request_fingerprint, policy_snapshot_version, participant_count,
        max_duration_seconds, input_bitrate_bps, state, ends_at)
      values($1, $2, $3, $4, $5, 'deadline', decode(repeat('00', 32), 'hex'),
        'episode_config.v2', 1, 7200, 128000, 'reserved', to_timestamp($6::bigint / 1000.0))
      """,
      scope ++ [recording_uuid, reservation_uuid, future_deadline]
    )

    Postgrex.query!(
      connection,
      """
      insert into recording_pipelines(tenant_id, recording_id, reservation_id, capture_epoch, state)
      values($1, $2, $3, 2, 'capturing_segmented')
      """,
      [tenant_uuid, recording_uuid, reservation_uuid]
    )

    {:ok, early} =
      Operation.new("early_deadline_stop", :recording_capture_stopped, %{
        "recordingId" => recording_id,
        "deadlineAtMs" => future_deadline,
        "captureEpoch" => 2
      })

    assert {:error, :stale_recording_fence} =
             Postgres.begin_internal_operation(fixture.episode, early)

    deadline = System.system_time(:millisecond) - 1_000

    Postgrex.query!(
      connection,
      "update recording_reservations set ends_at = to_timestamp($2::bigint / 1000.0) where id = $1",
      [reservation_uuid, deadline]
    )

    for {suffix, epoch, observed_deadline} <- [
          {"old_epoch", 1, deadline},
          {"new_epoch", 3, deadline},
          {"wrong_deadline", 2, deadline - 1}
        ] do
      {:ok, invalid} =
        Operation.new("deadline_stop_" <> suffix, :recording_capture_stopped, %{
          "recordingId" => recording_id,
          "deadlineAtMs" => observed_deadline,
          "captureEpoch" => epoch
        })

      assert {:error, :stale_recording_fence} =
               Postgres.begin_internal_operation(fixture.episode, invalid)
    end

    {:ok, stopped} =
      Operation.new("deadline_capture_stopped", :recording_capture_stopped, %{
        "recordingId" => recording_id,
        "deadlineAtMs" => deadline,
        "captureEpoch" => 2
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, stopped)

    assert {:ok, :pending} =
             Postgrex.transaction(Enum.at(connections, 2), fn transaction ->
               Postgrex.query!(
                 transaction,
                 "select recording_id from recording_pipelines where recording_id = $1 for update",
                 [recording_uuid]
               )

               assert {:retryable, :decision_unavailable} =
                        Postgres.finalize_operation(
                          fixture.episode,
                          operation_id,
                          {:confirmed, :local}
                        )

               assert {:ok, %{status: :pending}} =
                        Postgres.read_operation(fixture.episode, operation_id)

               :pending
             end)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, operation_id, {:confirmed, :local})

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(fixture.episode, operation_id, {:confirmed, :local})

    assert [["stopped", nil, "active", "stopped"]] =
             query_rows(
               fixture,
               """
               select recording.status, recording.stop_external_operation_id, episode.status,
                 control.folded_state #>> '{recording,status}'
               from sync_recordings recording
               join episodes episode on episode.id = recording.episode_id
               join sync_episode_control control on control.tenant_id = recording.tenant_id and control.episode_id = recording.episode_id
               where recording.tenant_id = $1 and recording.episode_id = $2 and recording.recording_id = $3::uuid
               """,
               [recording_uuid]
             )
  end

  test "capture stopped remains durable when its pending Episode end later fails", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = activate_recording(connection, fixture, "failed_end_stop", 1)

    {:ok, ending} = Operation.new("failed_end_stop_episode", :tenant_end_episode, %{})

    assert {:ok, %{external_operation_id: end_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, ending)

    {:ok, stopped} =
      Operation.recording_capture_stopped(
        "failed_end_capture_stopped",
        recording_id,
        end_operation_id,
        2
      )

    assert {:ok, %{external_operation_id: stopped_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, stopped)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               stopped_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(
               fixture.episode,
               end_operation_id,
               {:failed, :unsupported_effect}
             )

    assert [
             [
               "applied",
               "failed",
               "tenant_end_episode",
               "stopped",
               "active",
               "stopped",
               1,
               1
             ]
           ] = recording_stop_rows(fixture, stopped_operation_id, end_operation_id)
  end

  test "capture stopped settles without resurrecting Recording after Episode end wins the race",
       %{
         connections: connections
       } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 1, artifact_policy("manual"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    recording_id = activate_recording(connection, fixture, "applied_end_stop", 1)

    {:ok, ending} = Operation.new("applied_end_stop_episode", :tenant_end_episode, %{})

    assert {:ok, %{external_operation_id: end_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, ending)

    {:ok, stopped} =
      Operation.recording_capture_stopped(
        "applied_end_capture_stopped",
        recording_id,
        end_operation_id,
        2
      )

    assert {:ok, %{external_operation_id: stopped_operation_id}} =
             Postgres.begin_internal_operation(fixture.episode, stopped)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               end_operation_id,
               {:confirmed, :provider}
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               stopped_operation_id,
               {:confirmed, :local}
             )

    assert [
             [
               "applied",
               "applied",
               "tenant_end_episode",
               "stopped",
               "ended",
               nil,
               1,
               0
             ]
           ] = recording_stop_rows(fixture, stopped_operation_id, end_operation_id)
  end

  test "manual and disabled Recording policies do not queue an automatic start", %{
    connections: connections
  } do
    connection = hd(connections)

    Enum.each(["manual", "disabled"], fn mode ->
      fixture = SyncPostgres.seed_pending_join(connection, artifact_policy(mode))
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

      assert {:ok, %{result: :applied, event: %{name: "participant_joined", revision: 1}}} =
               Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

      assert [["active", "applied", 1, 0, 0]] = recording_activation_rows(fixture)
    end)
  end

  test "an ended Episode rejects both a pending join and a direct automatic start", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection, artifact_policy("automatic"))
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Postgrex.query!(
      connection,
      "update episodes set status = 'ended', ended_at = now() where id = $1",
      [UUID.dump!(fixture.episode.episode_id)]
    )

    assert {:error, :episode_ending} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    {:ok, operation} =
      Operation.system_recording_start(
        "ended_episode_automatic_recording",
        UUID.generate(),
        2
      )

    assert {:error, :episode_ended} =
             Postgres.begin_internal_operation(fixture.episode, operation)

    assert [["joining", "pending", 0, 0, 0]] = recording_activation_rows(fixture)
  end

  @tag :host_exit
  test "webhook failure rolls the product, control Event, operation, Event, and fanout back together",
       %{
         connections: connections
       } do
    test_pid = self()
    handler_id = "postgres-webhook-rollback-metrics-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach_many(
        handler_id,
        [[:chalk, :sync, :webhook, :production], [:chalk, :sync, :webhook, :fanout]],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:webhook_metric, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    connection = hd(connections)

    seed = SyncPostgres.seed_episode(connection, 2)

    fixture =
      %{episode: seed.episode, identity: Enum.at(seed.identities, 1)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    {:ok, operation} = Operation.new("webhook_rollback_01", :participant_leave, %{})

    assert {:ok, %{result: :pending} = pending} =
             Postgres.begin_operation(fixture.identity, operation)

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("injected webhook rollback")
    end)

    try do
      assert {:retryable, :decision_unavailable} =
               Postgres.finalize_operation(
                 fixture.episode,
                 pending.external_operation_id,
                 leave_outcome(fixture.identity)
               )
    after
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
    end

    assert [["leaving", "pending", 2, 0, 0]] =
             query_rows(
               fixture,
               """
               select p.status, o.status, c.control_revision,
                 (select count(*) from webhook_events e where e.tenant_id = $1),
                 (select count(*) from webhook_deliveries d where d.tenant_id = $1)
               from participants p
               join sync_external_operations o
                 on o.tenant_id = p.tenant_id and o.target_participant_id = p.id
               join sync_episode_control c
                 on c.tenant_id = p.tenant_id and c.episode_id = p.episode_id
               where p.tenant_id = $1 and p.episode_id = $2 and p.id = $3
               """,
               [UUID.dump!(fixture.identity.participant_id)]
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               pending.external_operation_id,
               leave_outcome(fixture.identity)
             )

    assert_receive {:webhook_metric, [:chalk, :sync, :webhook, :production], %{count: 1},
                    %{
                      api_version: 1,
                      event_name: "participant.left",
                      outcome: :committed
                    }}

    assert_receive {:webhook_metric, [:chalk, :sync, :webhook, :fanout], %{count: 1},
                    %{api_version: 1, event_name: "participant.left", outcome: :queued}}

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(
               fixture.episode,
               pending.external_operation_id,
               leave_outcome(fixture.identity)
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50
  end

  defp insert_trusted_capture_ready(
         connection,
         fixture,
         request_key,
         recording_id,
         start_operation_id,
         capture_epoch
       ) do
    external_operation_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active
      ) values ($1, $2, $3, $4, $5, $6, 'recording_capture_ready', $7, $8, false)
      """,
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(fixture.episode.space_id),
        UUID.dump!(fixture.episode.episode_id),
        UUID.dump!(external_operation_id),
        request_key,
        :crypto.hash(:sha256, request_key),
        UUID.dump!(recording_id),
        %{
          "recordingId" => recording_id,
          "startOperationId" => start_operation_id,
          "captureEpoch" => capture_epoch
        }
      ]
    )

    external_operation_id
  end

  defp insert_trusted_capture_failure(
         connection,
         fixture,
         request_key,
         recording_id,
         start_operation_id,
         failure_code \\ "capture_reservation_expired"
       ) do
    external_operation_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active
      ) values ($1, $2, $3, $4, $5, $6, 'recording_capture_failed', $7, $8, false)
      """,
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(fixture.episode.space_id),
        UUID.dump!(fixture.episode.episode_id),
        UUID.dump!(external_operation_id),
        request_key,
        :crypto.hash(:sha256, request_key),
        UUID.dump!(recording_id),
        %{
          "recordingId" => recording_id,
          "startOperationId" => start_operation_id,
          "failureCode" => failure_code
        }
      ]
    )

    external_operation_id
  end

  defp insert_trusted_capture_stopped(
         connection,
         fixture,
         request_key,
         recording_id,
         stop_operation_id,
         capture_epoch
       ) do
    external_operation_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active
      ) values ($1, $2, $3, $4, $5, $6, 'recording_capture_stopped', $7, $8, false)
      """,
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(fixture.episode.space_id),
        UUID.dump!(fixture.episode.episode_id),
        UUID.dump!(external_operation_id),
        request_key,
        :crypto.hash(:sha256, request_key),
        UUID.dump!(recording_id),
        %{
          "recordingId" => recording_id,
          "stopOperationId" => stop_operation_id,
          "captureEpoch" => capture_epoch
        }
      ]
    )

    external_operation_id
  end

  defp prepare_active_recording_state(
         connection,
         fixture,
         "starting",
         recording_id,
         start_operation_id
       ) do
    late_ready_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        "active_failure_starting_late_ready",
        recording_id,
        start_operation_id,
        1
      )

    {late_ready_operation_id, nil, nil}
  end

  defp prepare_active_recording_state(
         connection,
         fixture,
         active_status,
         recording_id,
         start_operation_id
       )
       when active_status in ["recording", "stopping"] do
    ready_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        "active_failure_#{active_status}_ready",
        recording_id,
        start_operation_id,
        1
      )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               ready_operation_id,
               {:confirmed, :local}
             )

    if active_status == "recording" do
      {nil, nil, nil}
    else
      {:ok, stop} =
        Operation.new("active_failure_stopping_stop", :stop_recording, %{
          "recordingId" => recording_id
        })

      assert {:ok, %{external_operation_id: stop_operation_id}} =
               Postgres.begin_operation(hd(fixture.identities), stop)

      late_stopped_operation_id =
        insert_trusted_capture_stopped(
          connection,
          fixture,
          "active_failure_stopping_late_stopped",
          recording_id,
          stop_operation_id,
          1
        )

      {nil, stop_operation_id, late_stopped_operation_id}
    end
  end

  defp activate_recording(connection, fixture, request_prefix, capture_epoch) do
    recording_id = UUID.generate()

    {:ok, start} =
      Operation.new(request_prefix <> "_recording_start", :start_recording, %{
        "recordingId" => recording_id
      })

    {:ok, %{external_operation_id: start_operation_id}} =
      Postgres.begin_operation(hd(fixture.identities), start)

    {:ok, %{result: :applied}} =
      Postgres.finalize_operation(
        fixture.episode,
        start_operation_id,
        {:confirmed, :recording}
      )

    ready_operation_id =
      insert_trusted_capture_ready(
        connection,
        fixture,
        request_prefix <> "_capture_ready",
        recording_id,
        start_operation_id,
        capture_epoch
      )

    {:ok, %{result: :applied}} =
      Postgres.finalize_operation(
        fixture.episode,
        ready_operation_id,
        {:confirmed, :local}
      )

    recording_id
  end

  defp recording_capture_rows(fixture, external_operation_id) do
    query_rows(
      fixture,
      """
      select operation.status, recording.status,
        coalesce((recording.adapter_metadata ->> 'capture_epoch')::bigint, 0)
      from sync_external_operations operation
      join sync_recordings recording
        on recording.tenant_id = operation.tenant_id
        and recording.episode_id = operation.episode_id
        and recording.recording_id = operation.recording_id
      where operation.tenant_id = $1 and operation.episode_id = $2
        and operation.external_operation_id = $3
      """,
      [UUID.dump!(external_operation_id)]
    )
  end

  defp recording_failure_rows(fixture, external_operation_id) do
    query_rows(
      fixture,
      """
      select failure.status, start_operation.status, recording.status, recording.failure_code,
        control.folded_state #>> '{recording,status}',
        control.folded_state #>> '{recording,failure_code}',
        (select count(*)
         from sync_control_events event
         where event.tenant_id = failure.tenant_id
           and event.episode_id = failure.episode_id
           and event.external_operation_id = failure.external_operation_id
           and event.event_name = 'recording_status_changed')
      from sync_external_operations failure
      join sync_external_operations start_operation
        on start_operation.tenant_id = failure.tenant_id
        and start_operation.episode_id = failure.episode_id
        and start_operation.external_operation_id = (failure.payload ->> 'startOperationId')::uuid
      join sync_recordings recording
        on recording.tenant_id = failure.tenant_id
        and recording.episode_id = failure.episode_id
        and recording.recording_id = failure.recording_id
      join sync_episode_control control
        on control.tenant_id = failure.tenant_id
        and control.episode_id = failure.episode_id
      where failure.tenant_id = $1 and failure.episode_id = $2
        and failure.external_operation_id = $3
      """,
      [UUID.dump!(external_operation_id)]
    )
  end

  defp recording_stop_rows(fixture, stopped_operation_id, source_operation_id) do
    query_rows(
      fixture,
      """
      select stopped.status, source.status, source.operation_name, recording.status,
        episode.status, control.folded_state #>> '{recording,status}',
        coalesce((recording.adapter_metadata ->> 'capture_epoch')::bigint, 0),
        (select count(*)
         from sync_control_events event
         where event.tenant_id = stopped.tenant_id
           and event.episode_id = stopped.episode_id
           and event.external_operation_id = stopped.external_operation_id
           and event.event_name = 'recording_status_changed')
      from sync_external_operations stopped
      join sync_external_operations source
        on source.tenant_id = stopped.tenant_id
        and source.episode_id = stopped.episode_id
        and source.external_operation_id = $4
      join sync_recordings recording
        on recording.tenant_id = stopped.tenant_id
        and recording.episode_id = stopped.episode_id
        and recording.recording_id = stopped.recording_id
      join episodes episode
        on episode.tenant_id = stopped.tenant_id
        and episode.id = stopped.episode_id
      join sync_episode_control control
        on control.tenant_id = stopped.tenant_id
        and control.episode_id = stopped.episode_id
      where stopped.tenant_id = $1 and stopped.episode_id = $2
        and stopped.external_operation_id = $3
      """,
      [UUID.dump!(stopped_operation_id), UUID.dump!(source_operation_id)]
    )
  end

  defp query_rows(fixture, sql, extra_params) do
    params =
      [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)] ++
        extra_params

    Database.connection(fixture.episode)
    |> Postgrex.query!(sql, params)
    |> Map.fetch!(:rows)
  end

  defp automatic_recording_rows(fixture) do
    query_rows(
      fixture,
      """
      select participant.status, intent.status, control.control_revision,
        operation.request_key, operation.operation_name, operation.actor_participant_id,
        operation.payload ->> 'actorKind', operation.payload ->> 'actorId',
        (operation.payload ->> 'policySnapshotVersion')::integer, operation.status,
        operation.recording_id, recording.recording_id, recording.status,
        recording.started_by_participant_id
      from participants participant
      join sync_lifecycle_intents intent
        on intent.tenant_id = participant.tenant_id
        and intent.episode_id = participant.episode_id
        and intent.participant_id = participant.id
      join sync_episode_control control
        on control.tenant_id = participant.tenant_id
        and control.episode_id = participant.episode_id
      join sync_external_operations operation
        on operation.tenant_id = participant.tenant_id
        and operation.episode_id = participant.episode_id
        and operation.operation_name = 'start_recording'
      join sync_recordings recording
        on recording.tenant_id = operation.tenant_id
        and recording.episode_id = operation.episode_id
        and recording.recording_id = operation.recording_id
      where participant.tenant_id = $1 and participant.episode_id = $2
        and participant.id = $3
      """,
      [UUID.dump!(fixture.identity.participant_id)]
    )
  end

  defp recording_activation_rows(fixture) do
    query_rows(
      fixture,
      """
      select participant.status, intent.status, control.control_revision,
        (select count(*) from sync_external_operations operation
          where operation.tenant_id = participant.tenant_id
            and operation.episode_id = participant.episode_id
            and operation.operation_name = 'start_recording'),
        (select count(*) from sync_recordings recording
          where recording.tenant_id = participant.tenant_id
            and recording.episode_id = participant.episode_id)
      from participants participant
      join sync_lifecycle_intents intent
        on intent.tenant_id = participant.tenant_id
        and intent.episode_id = participant.episode_id
        and intent.participant_id = participant.id
      join sync_episode_control control
        on control.tenant_id = participant.tenant_id
        and control.episode_id = participant.episode_id
      where participant.tenant_id = $1 and participant.episode_id = $2
        and participant.id = $3
      """,
      [UUID.dump!(fixture.identity.participant_id)]
    )
  end

  defp artifact_policy(mode) do
    %{
      artifact_policy: %{
        "schema_version" => "episode_config.v2",
        "recording" => %{
          "mode" => mode,
          "profile" => "composite_720p_v1",
          "retention_seconds" => 2_592_000
        },
        "transcription" => %{
          "mode" => "disabled",
          "retention_seconds" => 0,
          "source_window_seconds" => 0
        }
      }
    }
  end

  defp leave_outcome(identity) do
    {:applied, :participant_left,
     %{
       "participant_id" => identity.participant_id,
       "reason" => "left"
     }}
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection) do
      try do
        GenServer.stop(connection)
      catch
        :exit, {:noproc, _details} -> :ok
        :exit, :noproc -> :ok
      end
    end
  end
end
