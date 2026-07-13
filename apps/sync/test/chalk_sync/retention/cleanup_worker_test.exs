defmodule ChalkSync.Retention.CleanupWorkerTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  @now ~U[2026-07-12 00:00:00.000000Z]
  @retention_seconds 7 * 24 * 60 * 60

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

  test "cleans history at seven days and records the verified terminal checkpoint", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_session(connection, @retention_seconds, command?: true)
    cleanup_fixture(connection, fixture)
    before = control_counters(connection, fixture)

    %{
      event_count: event_count,
      event_bytes: event_bytes,
      receipt_count: receipt_count,
      receipt_bytes: receipt_bytes,
      lifecycle_intent_count: lifecycle_intent_count,
      lifecycle_intent_bytes: lifecycle_intent_bytes
    } = before

    assert {:ok,
            %Result{
              sessions: 1,
              event_rows: ^event_count,
              event_bytes: ^event_bytes,
              receipt_rows: ^receipt_count,
              receipt_bytes: ^receipt_bytes,
              lifecycle_intent_rows: ^lifecycle_intent_count,
              lifecycle_intent_bytes: ^lifecycle_intent_bytes
            }} = run_cleanup(connection)

    assert history_counts(connection, fixture) == [0, 0, 0]

    assert [
             [
               before.revision,
               before.digest,
               before.event_count,
               @now,
               before.event_count,
               before.event_bytes,
               before.receipt_count,
               before.receipt_bytes,
               before.lifecycle_intent_count,
               before.lifecycle_intent_bytes
             ]
           ] == checkpoint(connection, fixture)

    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    assert recovery.mode == :terminal
    assert recovery.head.revision == before.revision
    assert recovery.terminal_reason == :session_ended
    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection)
  end

  test "preserves active, pending, and in-window Session history", %{
    connections: connections
  } do
    connection = hd(connections)

    active = SyncPostgres.seed_pending_join(connection)
    cleanup_fixture(connection, active)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(active.session, active.lifecycle_intent_id)

    in_window = seed_ended_session(connection, @retention_seconds - 1)
    cleanup_fixture(connection, in_window)

    pending = seed_ended_session(connection, @retention_seconds + 1)
    cleanup_fixture(connection, pending)
    mark_intent_pending(connection, pending)

    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection)

    for fixture <- [active, in_window, pending] do
      assert [events, _receipts, intents] = history_counts(connection, fixture)
      assert events > 0
      assert intents > 0
      assert [[nil]] = cleaned_at(connection, fixture)
    end
  end

  test "honors the small batch bound", %{connections: connections} do
    connection = hd(connections)

    fixtures =
      Enum.map(1..3, fn _index ->
        fixture = seed_ended_session(connection, @retention_seconds + 1)
        cleanup_fixture(connection, fixture)
        fixture
      end)

    assert {:ok, %Result{sessions: 2}} = run_cleanup(connection, batch_size: 2)

    cleaned = Enum.count(fixtures, fn fixture -> checkpointed?(connection, fixture) end)
    assert cleaned == 2

    assert {:ok, %Result{sessions: 1}} = run_cleanup(connection, batch_size: 2)
    assert Enum.all?(fixtures, &checkpointed?(connection, &1))
  end

  test "skips a concurrently locked eligible control row", %{connections: connections} do
    [locker, worker | _rest] = connections
    locked = seed_ended_session(locker, @retention_seconds + 2)
    cleanup_fixture(locker, locked)
    available = seed_ended_session(locker, @retention_seconds + 1)
    cleanup_fixture(locker, available)
    parent = self()

    task =
      Task.async(fn ->
        Postgrex.transaction(locker, fn transaction ->
          Postgrex.query!(
            transaction,
            "select session_id from sync_session_control where tenant_id = $1 and session_id = $2 for update",
            session_ids(locked)
          )

          send(parent, :control_locked)

          receive do
            :release_control -> :ok
          end
        end)
      end)

    assert_receive :control_locked
    assert {:ok, %Result{sessions: 1}} = run_cleanup(worker, batch_size: 1)
    refute checkpointed?(worker, locked)
    assert checkpointed?(worker, available)

    send(task.pid, :release_control)
    assert {:ok, :ok} = Task.await(task)
  end

  test "rolls back when the independent fold detects corruption", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_session(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and session_id = $2 and revision = 1",
      session_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [events, _receipts, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)
  end

  test "rolls back every deletion when a durable counter mismatches", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_session(connection, @retention_seconds + 1, command?: true)
    cleanup_fixture(connection, fixture)
    history_before = history_counts(connection, fixture)
    orchestration_before = orchestration_counts(connection, fixture)

    Postgrex.query!(
      connection,
      """
      update sync_session_control set receipt_count = receipt_count + 1
      where tenant_id = $1 and session_id = $2
      """,
      session_ids(fixture)
    )

    assert {:error, {:invalid_history, :cleanup_counter_mismatch}} = run_cleanup(connection)
    assert history_counts(connection, fixture) == history_before
    assert orchestration_counts(connection, fixture) == orchestration_before
    refute checkpointed?(connection, fixture)
  end

  test "deletes terminal v3 orchestration provenance with exact durable counters", %{
    connections: connections
  } do
    connection = hd(connections)

    fixtures = [
      {:removal, seed_removal_provenance(connection)},
      {:recording, seed_recording_provenance(connection)},
      {:admission, seed_admission_provenance(connection)}
    ]

    for {kind, fixture} <- fixtures do
      cleanup_fixture(connection, fixture)
      synchronize_event_counters(connection, fixture)
      offset = %{removal: 3, recording: 2, admission: 1} |> Map.fetch!(kind)
      age_ended_session(connection, fixture, @retention_seconds + offset)
      assert Enum.any?(operation_rows(connection, fixture), &(!is_nil(Enum.at(&1, 2))))
      assert_independent_fold(connection, fixture)
    end

    fixtures
    |> Keyword.fetch!(:removal)
    |> then(&insert_terminal_self_parent_operation(connection, &1))

    for {kind, fixture} <- fixtures do
      expected = orchestration_measurements(connection, fixture)

      assert {:ok, %Result{sessions: 1} = result} = run_cleanup(connection, batch_size: 1)
      assert result_measurements(result) == expected, "wrong #{kind} deletion counters"
      assert checkpoint_measurements(connection, fixture) == expected
    end

    removal = fixtures |> Keyword.fetch!(:removal)

    for {_kind, fixture} <- fixtures do
      assert operation_rows(connection, fixture) == []
      assert orchestration_counts(connection, fixture) == [0, 0, 0, 0, 0, 0]
      assert history_counts(connection, fixture) == [0, 0, 0]
    end

    assert [["left"]] =
             Postgrex.query!(
               connection,
               "select status from participants where tenant_id = $1 and id = $2",
               [
                 UUID.dump!(removal.session.tenant_id),
                 UUID.dump!(removal.removed_participant_id)
               ]
             ).rows

    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection, batch_size: 3)
  end

  test "preserves ended Sessions with reconcilable v3 work", %{connections: connections} do
    connection = hd(connections)

    fixtures = [
      seed_blocked_session(connection, &insert_pending_external_operation/2),
      seed_blocked_session(connection, &insert_pending_grant/2),
      seed_blocked_session(connection, &insert_ambiguous_grant/2),
      seed_blocked_session(connection, &insert_active_screen_lease/2),
      seed_blocked_session(connection, &insert_unexpired_publication_fence/2),
      seed_admission_provenance(connection)
      |> block_ended_session(connection, &mark_admission_pending/2),
      seed_recording_provenance(connection)
      |> block_ended_session(connection, &mark_recording_active/2)
    ]

    Enum.each(fixtures, &cleanup_fixture(connection, &1))

    assert {:ok, %Result{sessions: 0}} = run_cleanup(connection, batch_size: 16)

    for fixture <- fixtures do
      assert [[nil]] = cleaned_at(connection, fixture)
      assert history_counts(connection, fixture) |> hd() > 0
    end
  end

  test "database rejects an incomplete retention checkpoint", %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    cleanup_fixture(connection, fixture)

    assert_raise Postgrex.Error, fn ->
      Postgrex.query!(
        connection,
        "update sync_session_control set retention_cleaned_at = $3 where tenant_id = $1 and session_id = $2",
        session_ids(fixture) ++ [@now]
      )
    end

    refute checkpointed?(connection, fixture)
  end

  defp seed_ended_session(connection, age_seconds, options \\ []) do
    fixture = SyncPostgres.seed_pending_join(connection)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    if Keyword.get(options, :command?, false) do
      assert {:ok, command} = Command.new("retention-command-0001", :raise_hand, %{})
      assert {:ok, %{result: :committed}} = Postgres.decide_command(fixture.identity, command)
    end

    assert {:ok, operation} = Operation.new("retention_session_end", :end_session, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(fixture.identity, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               operation_id,
               {:applied, :session_ended, %{"reason" => "ended_by_participant"}}
             )

    age_ended_session(connection, fixture, age_seconds)

    fixture
  end

  defp seed_removal_provenance(connection) do
    fixture = SyncPostgres.seed_session(connection, 2)
    [host, participant] = fixture.identities

    operation =
      operation("retention_remove_01", :remove_participant, %{
        "participantSessionId" => participant.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :participant_left,
               %{
                 "participant_session_id" => participant.participant_session_id,
                 "reason" => "removed"
               }
             })

    fixture
    |> Map.put(:removed_participant_id, participant.participant_session_id)
    |> finalize_session_end("retention_end_remove")
  end

  defp seed_recording_provenance(connection) do
    fixture = SyncPostgres.seed_session(connection)
    host = hd(fixture.identities)
    recording_id = UUID.generate()

    assert {:ok, %{external_operation_id: start_id}} =
             Postgres.begin_operation(
               host,
               operation("retention_record_start", :start_recording, %{
                 "recordingId" => recording_id
               })
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, start_id, {
               :applied,
               :recording_status_changed,
               %{"recording_id" => recording_id, "status" => "recording", "failure_code" => nil}
             })

    assert {:ok, %{external_operation_id: stop_id}} =
             Postgres.begin_operation(
               host,
               operation("retention_record_stop_", :stop_recording, %{
                 "recordingId" => recording_id
               })
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, stop_id, {
               :applied,
               :recording_status_changed,
               %{"recording_id" => recording_id, "status" => "stopped", "failure_code" => nil}
             })

    fixture
    |> Map.put(:start_operation_id, start_id)
    |> Map.put(:stop_operation_id, stop_id)
    |> finalize_session_end("retention_end_record")
  end

  defp seed_admission_provenance(connection) do
    fixture =
      connection
      |> SyncPostgres.seed_session()
      |> then(&SyncPostgres.seed_admission_request(connection, &1))

    host = hd(fixture.identities)

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(
               host,
               operation("retention_admit_01", :admit_participant, %{
                 "admissionRequestId" => fixture.admission_request_id
               })
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :participant_joined,
               %{
                 "participant_session_id" => fixture.admission_participant_id,
                 "display_name" => "Waiting Participant",
                 "role" => "participant",
                 "eligible_roles" => ["participant"],
                 "admission_revision" => fixture.state.revision + 1
               }
             })

    fixture
    |> Map.put(:admission_operation_id, operation_id)
    |> finalize_session_end("retention_end_admit_")
  end

  defp finalize_session_end(fixture, request_key) do
    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(
               hd(fixture.identities),
               operation(request_key, :end_session, %{})
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               operation_id,
               {:applied, :session_ended, %{"reason" => "ended_by_participant"}}
             )

    fixture
  end

  defp age_ended_session(connection, fixture, age_seconds) do
    ended_at = DateTime.add(@now, -age_seconds, :second)

    Postgrex.query!(
      connection,
      "update room_sessions set ended_at = $3 where tenant_id = $1 and id = $2",
      session_ids(fixture) ++ [ended_at]
    )
  end

  defp operation(request_key, name, payload) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    operation
  end

  defp operation_rows(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      select operation_name, status, applied_event_id, applied_revision
      from sync_external_operations
      where tenant_id = $1 and session_id = $2
      order by created_at, external_operation_id
      """,
      session_ids(fixture)
    ).rows
  end

  defp assert_independent_fold(connection, fixture) do
    state =
      connection
      |> Postgrex.query!(
        """
        select base_revision, revision, event_name, payload
        from sync_control_events
        where tenant_id = $1 and session_id = $2
        order by revision
        """,
        session_ids(fixture)
      )
      |> Map.fetch!(:rows)
      |> Enum.reduce(Reducer.new(fixture.session.session_id), fn
        [base_revision, revision, name, payload], state ->
          {:ok, next} =
            Reducer.apply_event(state, %{
              base_revision: base_revision,
              revision: revision,
              name: name,
              payload: payload
            })

          next
      end)

    assert [
             [
               control_revision,
               folded_state,
               digest,
               participant_event_count,
               participant_event_bytes,
               lifecycle_event_count,
               lifecycle_event_bytes
             ]
           ] =
             Postgrex.query!(
               connection,
               """
               select control_revision, folded_state, state_digest,
                 participant_event_count, participant_event_bytes,
                 lifecycle_event_count, lifecycle_event_bytes
               from sync_session_control
               where tenant_id = $1 and session_id = $2
               """,
               session_ids(fixture)
             ).rows

    assert state.revision == control_revision
    assert Reducer.snapshot(state) == folded_state
    assert Reducer.digest(state) == digest

    assert [[event_count, event_bytes]] =
             Postgrex.query!(
               connection,
               """
               select count(*), sum(encoded_bytes)
               from sync_control_events
               where tenant_id = $1 and session_id = $2
               """,
               session_ids(fixture)
             ).rows

    assert event_count == participant_event_count + lifecycle_event_count
    assert event_bytes == participant_event_bytes + lifecycle_event_bytes
  end

  defp synchronize_event_counters(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_session_control control
      set participant_event_count = event.participant_count,
          participant_event_bytes = event.participant_bytes,
          lifecycle_event_count = event.lifecycle_count,
          lifecycle_event_bytes = event.lifecycle_bytes
      from (
        select
          count(*) filter (where lifecycle_intent_id is null) as participant_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is null), 0) as participant_bytes,
          count(*) filter (where lifecycle_intent_id is not null) as lifecycle_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is not null), 0) as lifecycle_bytes
        from sync_control_events
        where tenant_id = $1 and session_id = $2
      ) event
      where control.tenant_id = $1 and control.session_id = $2
      """,
      session_ids(fixture)
    )
  end

  defp seed_blocked_session(connection, blocker) do
    fixture = seed_ended_session(connection, @retention_seconds + 1)
    blocker.(connection, fixture)
    fixture
  end

  defp block_ended_session(fixture, connection, blocker) do
    synchronize_event_counters(connection, fixture)
    age_ended_session(connection, fixture, @retention_seconds + 1)
    blocker.(connection, fixture)
    fixture
  end

  defp insert_pending_external_operation(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, room_id, session_id, external_operation_id, request_key,
        request_fingerprint, operation_name, payload
      ) values ($1, $2, $3, $4, 'retention_pending_op', $5, 'tenant_end_session', '{}')
      """,
      session_scope(fixture) ++ [UUID.dump!(UUID.generate()), :crypto.hash(:sha256, "pending")]
    )
  end

  defp insert_terminal_self_parent_operation(connection, fixture) do
    operation_id = UUID.dump!(UUID.generate())

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, room_id, session_id, external_operation_id,
        parent_external_operation_id, request_key, request_fingerprint,
        operation_name, source, payload, status, completed_at
      ) values (
        $1, $2, $3, $4, $4, 'retention_self_parent', $5,
        'role_transition_source_stop', 'camera', '{}', 'applied', $6
      )
      """,
      session_scope(fixture) ++
        [operation_id, :crypto.hash(:sha256, "self-parent"), @now]
    )
  end

  defp insert_pending_grant(connection, fixture), do: insert_grant(connection, fixture, "pending")

  defp insert_ambiguous_grant(connection, fixture),
    do: insert_grant(connection, fixture, "ambiguous")

  defp insert_grant(connection, fixture, status) do
    identity = fixture.identity

    Postgrex.query!(
      connection,
      """
      insert into sync_publication_grant_reservations (
        tenant_id, room_id, session_id, reservation_id, operation_id,
        participant_session_id, participant_generation, source, status, expires_at, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, 'camera', $8, $9, $10)
      """,
      session_scope(fixture) ++
        [
          UUID.dump!(UUID.generate()),
          "retention_grant_#{status}",
          UUID.dump!(identity.participant_session_id),
          identity.participant_session_generation,
          status,
          DateTime.add(@now, 60, :second),
          DateTime.add(@now, -60, :second)
        ]
    )
  end

  defp insert_active_screen_lease(connection, fixture) do
    identity = fixture.identity

    Postgrex.query!(
      connection,
      """
      insert into sync_screen_share_leases (
        tenant_id, room_id, session_id, lease_id, owner_participant_session_id,
        owner_generation, lease_generation, status, acquired_at, renewed_until, hard_expires_at
      ) values ($1, $2, $3, $4, $5, $6, 1, 'active', $7, $8, $9)
      """,
      session_scope(fixture) ++
        [
          UUID.dump!(UUID.generate()),
          UUID.dump!(identity.participant_session_id),
          identity.participant_session_generation,
          DateTime.add(@now, -10, :second),
          DateTime.add(@now, 30, :second),
          DateTime.add(@now, 60, :second)
        ]
    )
  end

  defp insert_unexpired_publication_fence(connection, fixture) do
    identity = fixture.identity

    [[operation_id]] =
      Postgrex.query!(
        connection,
        """
        select external_operation_id from sync_external_operations
        where tenant_id = $1 and session_id = $2 and status = 'applied'
        order by completed_at limit 1
        """,
        session_ids(fixture)
      ).rows

    Postgrex.query!(
      connection,
      """
      insert into sync_publication_fences (
        tenant_id, room_id, session_id, participant_session_id, participant_generation,
        source, external_operation_id, expires_at, created_at
      ) values ($1, $2, $3, $4, $5, 'microphone', $6, $7, $8)
      """,
      session_scope(fixture) ++
        [
          UUID.dump!(identity.participant_session_id),
          identity.participant_session_generation,
          operation_id,
          DateTime.add(@now, 60, :second),
          DateTime.add(@now, -60, :second)
        ]
    )
  end

  defp mark_admission_pending(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_admission_requests set status = 'pending', completed_at = null
      where tenant_id = $1 and session_id = $2
      """,
      session_ids(fixture)
    )
  end

  defp mark_recording_active(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_recordings set status = 'recording', completed_at = null
      where tenant_id = $1 and session_id = $2
      """,
      session_ids(fixture)
    )
  end

  defp orchestration_measurements(connection, fixture) do
    [
      external_operations: "sync_external_operations",
      admission_requests: "sync_admission_requests",
      recordings: "sync_recordings",
      screen_share_leases: "sync_screen_share_leases",
      publication_fences: "sync_publication_fences",
      grant_reservations: "sync_publication_grant_reservations"
    ]
    |> Map.new(fn {name, table} ->
      [[rows, bytes]] =
        Postgrex.query!(
          connection,
          "select count(*)::bigint, coalesce(sum(pg_column_size(#{table})), 0)::bigint from #{table} where tenant_id = $1 and session_id = $2",
          session_ids(fixture)
        ).rows

      {name, {rows, bytes}}
    end)
  end

  defp result_measurements(result) do
    %{
      external_operations: {result.external_operation_rows, result.external_operation_bytes},
      admission_requests: {result.admission_request_rows, result.admission_request_bytes},
      recordings: {result.recording_rows, result.recording_bytes},
      screen_share_leases: {result.screen_share_lease_rows, result.screen_share_lease_bytes},
      publication_fences: {result.publication_fence_rows, result.publication_fence_bytes},
      grant_reservations:
        {result.publication_grant_reservation_rows, result.publication_grant_reservation_bytes}
    }
  end

  defp checkpoint_measurements(connection, fixture) do
    [
      [
        external_rows,
        external_bytes,
        admission_rows,
        admission_bytes,
        recording_rows,
        recording_bytes,
        lease_rows,
        lease_bytes,
        fence_rows,
        fence_bytes,
        grant_rows,
        grant_bytes
      ]
    ] =
      Postgrex.query!(
        connection,
        """
        select retention_deleted_external_operation_rows,
          retention_deleted_external_operation_bytes,
          retention_deleted_admission_request_rows,
          retention_deleted_admission_request_bytes,
          retention_deleted_recording_rows, retention_deleted_recording_bytes,
          retention_deleted_screen_share_lease_rows,
          retention_deleted_screen_share_lease_bytes,
          retention_deleted_publication_fence_rows,
          retention_deleted_publication_fence_bytes,
          retention_deleted_publication_grant_reservation_rows,
          retention_deleted_publication_grant_reservation_bytes
        from sync_session_control where tenant_id = $1 and session_id = $2
        """,
        session_ids(fixture)
      ).rows

    %{
      external_operations: {external_rows, external_bytes},
      admission_requests: {admission_rows, admission_bytes},
      recordings: {recording_rows, recording_bytes},
      screen_share_leases: {lease_rows, lease_bytes},
      publication_fences: {fence_rows, fence_bytes},
      grant_reservations: {grant_rows, grant_bytes}
    }
  end

  defp orchestration_counts(connection, fixture) do
    orchestration_measurements(connection, fixture)
    |> Map.values()
    |> Enum.map(&elem(&1, 0))
  end

  defp run_cleanup(connection, options \\ []) do
    CleanupWorker.run_once(connection, Keyword.put(options, :clock, fn -> @now end))
  end

  defp control_counters(connection, fixture) do
    [
      [
        revision,
        digest,
        event_count,
        event_bytes,
        receipt_count,
        receipt_bytes,
        intent_count,
        intent_bytes
      ]
    ] =
      Postgrex.query!(
        connection,
        """
        select
          control_revision,
          state_digest,
          participant_event_count + lifecycle_event_count,
          participant_event_bytes + lifecycle_event_bytes,
          receipt_count,
          receipt_bytes,
          lifecycle_intent_count,
          lifecycle_intent_bytes
        from sync_session_control
        where tenant_id = $1 and session_id = $2
        """,
        session_ids(fixture)
      ).rows

    %{
      revision: revision,
      digest: digest,
      event_count: event_count,
      event_bytes: event_bytes,
      receipt_count: receipt_count,
      receipt_bytes: receipt_bytes,
      lifecycle_intent_count: intent_count,
      lifecycle_intent_bytes: intent_bytes
    }
  end

  defp checkpoint(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      select
        retention_checkpoint_revision,
        retention_checkpoint_state_digest,
        retention_checkpoint_event_count,
        retention_cleaned_at,
        retention_deleted_event_rows,
        retention_deleted_event_bytes,
        retention_deleted_receipt_rows,
        retention_deleted_receipt_bytes,
        retention_deleted_lifecycle_intent_rows,
        retention_deleted_lifecycle_intent_bytes
      from sync_session_control
      where tenant_id = $1 and session_id = $2
      """,
      session_ids(fixture)
    ).rows
  end

  defp history_counts(connection, fixture) do
    [[events, receipts, intents]] =
      Postgrex.query!(
        connection,
        """
        select
          (select count(*) from sync_control_events where tenant_id = $1 and session_id = $2),
          (select count(*) from sync_command_receipts where tenant_id = $1 and session_id = $2),
          (select count(*) from sync_lifecycle_intents where tenant_id = $1 and session_id = $2)
        """,
        session_ids(fixture)
      ).rows

    [events, receipts, intents]
  end

  defp mark_intent_pending(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set status = 'pending', applied_event_id = null, applied_revision = null, completed_at = null
      where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
      """,
      session_ids(fixture) ++ [UUID.dump!(fixture.lifecycle_intent_id)]
    )
  end

  defp cleaned_at(connection, fixture) do
    Postgrex.query!(
      connection,
      "select retention_cleaned_at from sync_session_control where tenant_id = $1 and session_id = $2",
      session_ids(fixture)
    ).rows
  end

  defp checkpointed?(connection, fixture), do: cleaned_at(connection, fixture) != [[nil]]

  defp cleanup_fixture(connection, fixture) do
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)
  end

  defp session_ids(fixture),
    do: [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)]

  defp session_scope(fixture),
    do: [
      UUID.dump!(fixture.session.tenant_id),
      UUID.dump!(fixture.session.room_id),
      UUID.dump!(fixture.session.session_id)
    ]

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
