defmodule ChalkSync.Stateholder.PostgresExternalOperationTest do
  use ExUnit.Case, async: false

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
      connections = SyncPostgres.start_connections(@database_url, 6)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    {:ok, fixture: fixture}
  end

  test "accepts, claims, reads, and atomically finalizes moderation", %{fixture: fixture} do
    [host, guest] = fixture.identities

    operation =
      operation("mute_operation_01", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{result: :pending, delivery: :original} = pending} =
             Postgres.begin_operation(host, operation)

    assert {:ok, %{result: :pending, delivery: :duplicate}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {_session, external} =
             Enum.find(claimed, fn {session, candidate} ->
               session == fixture.session &&
                 candidate.external_operation_id == pending.external_operation_id
             end)

    assert external.attempt_count == 1
    assert external.target_participant_generation == 1

    assert {:ok, stored} =
             Postgres.read_operation(fixture.session, pending.external_operation_id)

    assert stored.attempt_count == 1

    outcome =
      {:applied, :participant_microphone_stopped,
       %{"participant_session_id" => guest.participant_session_id}}

    assert {:ok, %{result: :applied, delivery: :original, revision: 3} = applied} =
             Postgres.finalize_operation(fixture.session, pending.external_operation_id, outcome)

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: 3}} =
             Postgres.finalize_operation(fixture.session, pending.external_operation_id, outcome)

    assert {:ok, %{status: :applied, applied_event_id: event_id}} =
             Postgres.read_operation(fixture.session, pending.external_operation_id)

    assert event_id == applied.event_id
  end

  test "deduplicates keys, rejects conflicts, and authorizes from the locked role mapping", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    accepted =
      operation("remove_request_01", :remove_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    conflict =
      operation("remove_request_01", :remove_participant, %{
        "participantSessionId" => host.participant_session_id
      })

    asserted = %{guest | capabilities: ["removeParticipant", "muteOthers"]}

    assert {:ok, %{result: :rejected, reason: :capability_denied}} =
             Postgres.begin_operation(asserted, conflict)

    assert {:ok, %{result: :pending}} = Postgres.begin_operation(host, accepted)

    assert {:ok, %{result: :command_id_conflict, reason: :command_id_conflict}} =
             Postgres.begin_operation(host, conflict)

    stale = %{host | participant_session_generation: 2}

    assert {:ok, %{result: :rejected, reason: :stale_participant_generation}} =
             Postgres.begin_operation(
               stale,
               operation("stale_actor_op01", :mute_participant, %{
                 "participantSessionId" => guest.participant_session_id
               })
             )
  end

  test "participant authority reads the current role mapping with an exact generation fence", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    assert {:ok,
            %{
              participant_session_id: host_id,
              generation: 1,
              role: "host",
              capabilities: host_capabilities
            }} =
             Postgres.participant_authority(
               fixture.session,
               host.participant_session_id,
               1
             )

    assert host_id == host.participant_session_id
    assert "muteOthers" in host_capabilities

    query_rows(
      fixture,
      """
      update participants
      set role = 'cohost', updated_at = now()
      where tenant_id = $1 and session_id = $2 and id = $3
      """,
      [UUID.dump!(guest.participant_session_id)]
    )

    assert {:ok,
            %{
              generation: 1,
              role: "cohost",
              capabilities: current_capabilities
            }} =
             Postgres.participant_authority(
               fixture.session,
               guest.participant_session_id,
               nil
             )

    assert current_capabilities == fixture.state.role_capabilities["cohost"]
    refute current_capabilities == guest.capabilities

    assert {:error, :stale_participant_generation} =
             Postgres.participant_authority(
               fixture.session,
               guest.participant_session_id,
               2
             )
  end

  test "terminal failure releases moderation fences and accepted removal state", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    external =
      operation("remove_failure_01", :remove_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, external)

    assert [["leaving", 3]] =
             query_rows(
               fixture,
               """
               select p.status, count(f.source)
               from participants p
               join sync_publication_fences f
                 on f.tenant_id = p.tenant_id and f.session_id = p.session_id
                and f.participant_session_id = p.id
               where p.tenant_id = $1 and p.session_id = $2 and p.id = $3
               group by p.status
               """,
               [UUID.dump!(guest.participant_session_id)]
             )

    assert {:ok, %{result: :failed, reason: :provider_rejected}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :failed,
               :provider_rejected
             })

    assert [["active", 0]] =
             query_rows(
               fixture,
               """
               select p.status, count(f.source)
               from participants p
               left join sync_publication_fences f
                 on f.tenant_id = p.tenant_id and f.session_id = p.session_id
                and f.participant_session_id = p.id
               where p.tenant_id = $1 and p.session_id = $2 and p.id = $3
               group by p.status
               """,
               [UUID.dump!(guest.participant_session_id)]
             )
  end

  test "recording acceptance and confirmation append starting, recording, stopping, and stopped",
       %{
         fixture: fixture
       } do
    host = hd(fixture.identities)
    recording_id = UUID.generate()

    start = operation("recording_start01", :start_recording, %{"recordingId" => recording_id})
    assert {:ok, %{external_operation_id: start_id}} = Postgres.begin_operation(host, start)

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.head.revision == 3
    assert recovery.snapshot["recording"]["status"] == "starting"

    assert {:ok, %{result: :rejected, reason: :recording_in_progress}} =
             Postgres.begin_operation(
               host,
               operation("recording_start02", :start_recording, %{
                 "recordingId" => UUID.generate()
               })
             )

    assert {:ok, %{revision: 4}} =
             Postgres.finalize_operation(fixture.session, start_id, {
               :applied,
               :recording_status_changed,
               %{"recording_id" => recording_id, "status" => "recording", "failure_code" => nil}
             })

    stop = operation("recording_stop_01", :stop_recording, %{"recordingId" => recording_id})
    assert {:ok, %{external_operation_id: stop_id}} = Postgres.begin_operation(host, stop)

    assert {:ok, %{revision: 6}} =
             Postgres.finalize_operation(fixture.session, stop_id, {
               :applied,
               :recording_status_changed,
               %{"recording_id" => recording_id, "status" => "stopped", "failure_code" => nil}
             })

    assert [["stopped", 1]] =
             query_rows(fixture, """
             select status, count(*) over ()
             from sync_recordings
             where tenant_id = $1 and session_id = $2
             """)

    assert [["starting"], ["recording"], ["stopping"], ["stopped"]] =
             query_rows(fixture, """
             select payload->>'status'
             from sync_control_events
             where tenant_id = $1 and session_id = $2
               and event_name = 'recording_status_changed'
             order by revision
             """)
  end

  test "admission approval commits against the linked lifecycle event", %{
    connections: connections,
    fixture: seeded
  } do
    fixture = SyncPostgres.seed_admission_request(hd(connections), seeded)
    host = hd(fixture.identities)

    approve =
      operation("admission_allow01", :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, approve)

    payload = %{
      "participant_session_id" => fixture.admission_participant_id,
      "display_name" => "Waiting Participant",
      "role" => "participant",
      "eligible_roles" => ["participant"],
      "admission_revision" => fixture.state.revision + 1
    }

    assert {:ok, %{result: :applied, revision: 4, event_id: event_id}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :participant_joined,
               payload
             })

    assert [["admitted", "active", true, true]] =
             query_rows(
               fixture,
               """
               select a.status, p.status,
                      e.lifecycle_intent_id is not null,
                      e.external_operation_id is null
               from sync_admission_requests a
               join participants p on p.id = a.participant_session_id
               join sync_control_events e on e.event_id = $3
               where a.tenant_id = $1 and a.session_id = $2
               """,
               [UUID.dump!(event_id)]
             )
  end

  test "admission denial and expiry serialize to one terminal decision", %{
    connections: connections,
    fixture: seeded
  } do
    fixture = SyncPostgres.seed_admission_request(hd(connections), seeded)
    host = hd(fixture.identities)

    query_rows(fixture, """
    update sync_admission_requests
    set requested_at = now() - interval '2 seconds',
        expires_at = now() - interval '1 second'
    where tenant_id = $1 and session_id = $2
    """)

    deny =
      operation("admission_deny_01", :deny_admission, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    expire =
      operation("admission_expire1", :admission_request_expired, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: deny_id}} = Postgres.begin_operation(host, deny)

    assert {:error, :invalid_state} =
             Postgres.begin_internal_operation(fixture.session, expire)

    dumped_deny_id = UUID.dump!(deny_id)

    assert [[^dumped_deny_id, 1]] =
             query_rows(
               fixture,
               """
               select a.decision_external_operation_id, count(o.external_operation_id)
               from sync_admission_requests a
               join sync_external_operations o
                 on o.tenant_id = a.tenant_id and o.session_id = a.session_id
                and o.external_operation_id = a.decision_external_operation_id
               where a.tenant_id = $1 and a.session_id = $2
               group by a.decision_external_operation_id
               """
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, deny_id, {
               :applied,
               :admission_denied,
               %{"admission_request_id" => fixture.admission_request_id}
             })

    assert [["denied", "left", "superseded", 1]] =
             query_rows(fixture, """
             select a.status, p.status, i.status, count(*) over ()
             from sync_admission_requests a
             join participants p on p.id = a.participant_session_id
             join sync_lifecycle_intents i
               on i.participant_session_id = a.participant_session_id
              and i.intent_name = 'participant_joined'
             where a.tenant_id = $1 and a.session_id = $2
             """)
  end

  test "concurrent admission decisions reserve exactly one pending operation", %{
    connections: connections,
    fixture: seeded
  } do
    fixture = SyncPostgres.seed_admission_request(hd(connections), seeded)
    host = hd(fixture.identities)

    operations = [
      operation("admission_race_admit", :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      }),
      operation("admission_race_deny1", :deny_admission, %{
        "admissionRequestId" => fixture.admission_request_id
      })
    ]

    results =
      operations
      |> Task.async_stream(&Postgres.begin_operation(host, &1),
        max_concurrency: 2,
        ordered: false
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert 1 == Enum.count(results, &match?({:ok, %{result: :pending}}, &1))
    assert 1 == Enum.count(results, &match?({:ok, %{result: :rejected}}, &1))

    assert [[1, 1, 1]] =
             query_rows(fixture, """
             select
               count(distinct o.external_operation_id) filter (where o.status = 'pending'),
               count(distinct r.command_id) filter (where r.outcome = 'rejected'),
               count(distinct a.decision_external_operation_id)
             from sync_admission_requests a
             left join sync_external_operations o
               on o.tenant_id = a.tenant_id and o.session_id = a.session_id
             left join sync_command_receipts r
               on r.tenant_id = a.tenant_id and r.session_id = a.session_id
             where a.tenant_id = $1 and a.session_id = $2
             """)
  end

  test "two concurrent finalizers append at most one exact-next fact", %{fixture: fixture} do
    [host, guest] = fixture.identities

    operation =
      operation("camera_concurrent1", :stop_participant_camera, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    outcome =
      {:applied, :participant_camera_stopped,
       %{"participant_session_id" => guest.participant_session_id}}

    results =
      1..2
      |> Task.async_stream(
        fn _ -> Postgres.finalize_operation(fixture.session, operation_id, outcome) end,
        max_concurrency: 2,
        ordered: false
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:ok, %{result: :applied}}, &1))

    assert [[1, 3, 3]] =
             query_rows(
               fixture,
               """
               select count(*), min(revision), max(revision)
               from sync_control_events
               where tenant_id = $1 and session_id = $2
                 and external_operation_id = $3
               """,
               [UUID.dump!(operation_id)]
             )
  end

  test "tenant host transfer and explicit leave update fold and participant products", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    transfer =
      operation("tenant_transfer01", :tenant_transfer_host, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: transfer_id}} =
             Postgres.begin_internal_operation(fixture.session, transfer)

    assert {:ok, %{revision: 3}} =
             Postgres.finalize_operation(fixture.session, transfer_id, {
               :applied,
               :host_transferred,
               %{
                 "previous_host_participant_session_id" => host.participant_session_id,
                 "new_host_participant_session_id" => guest.participant_session_id
               }
             })

    leave = operation("participant_leave1", :participant_leave, %{})
    assert {:ok, %{external_operation_id: leave_id}} = Postgres.begin_operation(host, leave)

    assert {:ok, %{revision: 4}} =
             Postgres.finalize_operation(fixture.session, leave_id, {
               :applied,
               :participant_left,
               %{"participant_session_id" => host.participant_session_id, "reason" => "left"}
             })

    assert [["left", "host", "active"]] =
             query_rows(
               fixture,
               """
               select old_host.status, new_host.role, new_host.status
               from participants old_host
               join participants new_host
                 on new_host.tenant_id = old_host.tenant_id
                and new_host.session_id = old_host.session_id
               where old_host.tenant_id = $1 and old_host.session_id = $2
                 and old_host.id = $3 and new_host.id = $4
               """,
               [UUID.dump!(host.participant_session_id), UUID.dump!(guest.participant_session_id)]
             )
  end

  test "tenant deadline changes are exact-generation facts", %{fixture: fixture} do
    deadline_at_ms =
      DateTime.utc_now() |> DateTime.add(120, :second) |> DateTime.to_unix(:millisecond)

    deadline =
      operation("tenant_deadline_01", :tenant_set_deadline, %{
        "deadlineAtMs" => deadline_at_ms,
        "deadlineGeneration" => 2
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(fixture.session, deadline)

    assert {:ok, %{revision: 3}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :deadline_changed,
               %{"deadline_at_ms" => deadline_at_ms, "deadline_generation" => 2}
             })

    assert [[2]] =
             query_rows(fixture, """
             select deadline_generation
             from room_sessions
             where tenant_id = $1 and id = $2
             """)

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.snapshot["deadline_generation"] == 2
    assert recovery.snapshot["deadline_at_ms"] == deadline_at_ms
  end

  test "participant end fences authority before confirmation and commits terminal state", %{
    fixture: fixture
  } do
    host = hd(fixture.identities)
    ending = operation("participant_end_01", :end_session, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, ending)

    assert [["ending", 6]] =
             query_rows(fixture, """
             select s.status, count(f.source)
             from room_sessions s
             join sync_publication_fences f
               on f.tenant_id = s.tenant_id and f.session_id = s.id
             where s.tenant_id = $1 and s.id = $2
             group by s.status
             """)

    assert {:ok, %{result: :applied, revision: 3}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :session_ended,
               %{"reason" => "ended_by_participant"}
             })

    assert [["ended", 0]] =
             query_rows(fixture, """
             select s.status, count(p.id) filter (where p.status <> 'left')
             from room_sessions s
             left join participants p
               on p.tenant_id = s.tenant_id and p.session_id = s.id
             where s.tenant_id = $1 and s.id = $2
             group by s.status
             """)
  end

  test "claiming is ordered, leases retries, and skips work locked by another node", %{
    connections: connections,
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    first =
      operation("claim_order_one1", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    second =
      operation("claim_order_two2", :stop_participant_camera, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: first_id}} = Postgres.begin_operation(host, first)
    assert {:ok, %{external_operation_id: second_id}} = Postgres.begin_operation(host, second)

    query_rows(
      fixture,
      """
      update sync_external_operations
      set next_attempt_at = case external_operation_id
        when $3 then now() - interval '2 seconds'
        else now() - interval '1 second'
      end
      where tenant_id = $1 and session_id = $2
        and external_operation_id in ($3, $4)
      """,
      [UUID.dump!(first_id), UUID.dump!(second_id)]
    )

    parent = self()
    lock_connection = Enum.at(connections, 1)

    locker =
      Task.async(fn ->
        Postgrex.transaction(lock_connection, fn transaction ->
          Postgrex.query!(
            transaction,
            "select external_operation_id from sync_external_operations where external_operation_id = $1 for update",
            [UUID.dump!(first_id)]
          )

          send(parent, :operation_locked)
          receive do: (:release_operation -> :ok)
        end)
      end)

    assert_receive :operation_locked, 2_000

    assert {:ok, [{_session, %{external_operation_id: ^second_id, attempt_count: 1}}]} =
             Postgres.claim_operations(1)

    send(locker.pid, :release_operation)
    assert {:ok, _result} = Task.await(locker, 2_000)

    assert {:ok, [{_session, %{external_operation_id: ^first_id, attempt_count: 1}}]} =
             Postgres.claim_operations(1)

    assert {:ok, []} = Postgres.claim_operations(2)
  end

  test "pending external work has a hard per-Session capacity", %{fixture: fixture} do
    [host, guest] = fixture.identities

    query_rows(fixture, """
    insert into sync_external_operations (
      tenant_id, room_id, session_id, external_operation_id, request_key,
      request_fingerprint, operation_name, payload
    )
    select $1, control.room_id, $2, gen_random_uuid(),
           'capacity_key_' || lpad(series::text, 8, '0'),
           decode(repeat('00', 32), 'hex'), 'tenant_end_session', '{}'::jsonb
    from sync_session_control control
    cross join generate_series(1, 2048) series
    where control.tenant_id = $1 and control.session_id = $2
    """)

    operation =
      operation("capacity_reject01", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:retryable, :overloaded} = Postgres.begin_operation(host, operation)

    assert [[2048, 0]] =
             query_rows(fixture, """
             select count(*), count(*) filter (where actor_participant_session_id is not null)
             from sync_external_operations
             where tenant_id = $1 and session_id = $2 and status = 'pending'
             """)
  end

  test "a changed deadline settles accepted maximum-duration work without a fact", %{
    fixture: fixture
  } do
    query_rows(fixture, """
    update room_sessions
    set created_at = now() - interval '2 minutes',
        deadline_at = now() - interval '1 second',
        maximum_duration_seconds = 119,
        deadline_generation = 2
    where tenant_id = $1 and id = $2
    """)

    expiry =
      operation("maximum_expiry_01", :maximum_duration_expired, %{
        "deadlineGeneration" => 2
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(fixture.session, expiry)

    query_rows(fixture, """
    update room_sessions
    set deadline_at = now() + interval '1 minute',
        maximum_duration_seconds = 180,
        deadline_generation = 3
    where tenant_id = $1 and id = $2
    """)

    assert {:ok, %{result: :failed, reason: :stale_deadline_generation}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :session_ended,
               %{"reason" => "maximum_duration"}
             })

    assert [["active", 0]] =
             query_rows(
               fixture,
               """
               select s.status, count(e.external_operation_id)
               from room_sessions s
               left join sync_control_events e
                 on e.tenant_id = s.tenant_id and e.session_id = s.id
                and e.external_operation_id = $3
               where s.tenant_id = $1 and s.id = $2
               group by s.status
               """,
               [UUID.dump!(operation_id)]
             )
  end

  test "stale maximum-duration generation is rejected before first acceptance", %{
    fixture: fixture
  } do
    query_rows(fixture, """
    update room_sessions
    set created_at = now() - interval '2 minutes',
        deadline_at = now() - interval '1 second',
        maximum_duration_seconds = 119,
        deadline_generation = 2
    where tenant_id = $1 and id = $2
    """)

    stale =
      operation("maximum_stale_001", :maximum_duration_expired, %{
        "deadlineGeneration" => 1
      })

    assert {:error, :stale_deadline_generation} =
             Postgres.begin_internal_operation(fixture.session, stale)

    assert [[0, "active", 2]] =
             query_rows(fixture, """
             select count(o.external_operation_id), s.status, s.deadline_generation
             from room_sessions s
             left join sync_external_operations o
               on o.tenant_id = s.tenant_id and o.session_id = s.id
              and o.operation_name = 'maximum_duration_expired'
             where s.tenant_id = $1 and s.id = $2
             group by s.status, s.deadline_generation
             """)
  end

  test "screen moderation releases the matching share lease after its exact fact", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities
    lease_id = UUID.generate()

    query_rows(
      fixture,
      """
      insert into sync_screen_share_leases (
        tenant_id, room_id, session_id, lease_id, owner_participant_session_id,
        owner_generation, lease_generation, status, acquired_at, renewed_until,
        hard_expires_at
      )
      select $1, room_id, $2, $3, $4, 1, 1, 'active', now(),
             now() + interval '1 minute', now() + interval '2 minutes'
      from sync_session_control
      where tenant_id = $1 and session_id = $2
      """,
      [UUID.dump!(lease_id), UUID.dump!(guest.participant_session_id)]
    )

    stop =
      operation("screen_stop_op_01", :stop_participant_screen_share, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} = Postgres.begin_operation(host, stop)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :participant_screen_share_stopped,
               %{"participant_session_id" => guest.participant_session_id}
             })

    assert [[0, 0]] =
             query_rows(fixture, """
             select
               (select count(*) from sync_screen_share_leases where tenant_id = $1 and session_id = $2),
               (select count(*) from sync_publication_fences where tenant_id = $1 and session_id = $2)
             """)
  end

  test "admission expiry succeeds only as its durable exact-next fact", %{
    connections: connections,
    fixture: seeded
  } do
    fixture = SyncPostgres.seed_admission_request(hd(connections), seeded)

    query_rows(fixture, """
    update sync_admission_requests
    set requested_at = now() - interval '2 seconds',
        expires_at = now() - interval '1 second'
    where tenant_id = $1 and session_id = $2
    """)

    expiry =
      operation("admission_expire2", :admission_request_expired, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(fixture.session, expiry)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :admission_expired,
               %{"admission_request_id" => fixture.admission_request_id}
             })

    assert [["expired", "left", "superseded", "admission_expired"]] =
             query_rows(fixture, """
             select a.status, p.status, i.status, e.event_name
             from sync_admission_requests a
             join participants p on p.id = a.participant_session_id
             join sync_lifecycle_intents i
               on i.participant_session_id = a.participant_session_id
              and i.intent_name = 'participant_joined'
             join sync_control_events e
               on e.external_operation_id = a.decision_external_operation_id
             where a.tenant_id = $1 and a.session_id = $2
             """)
  end

  test "tenant and maximum-duration endings use their distinct terminal reasons", %{
    connections: connections,
    fixture: tenant_fixture
  } do
    tenant_end = operation("tenant_end_op_001", :tenant_end_session, %{})

    assert {:ok, %{external_operation_id: tenant_end_id}} =
             Postgres.begin_internal_operation(tenant_fixture.session, tenant_end)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(tenant_fixture.session, tenant_end_id, {
               :applied,
               :session_ended,
               %{"reason" => "tenant_recovery"}
             })

    maximum_fixture = SyncPostgres.seed_session(hd(connections), 1)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), maximum_fixture.session) end)

    query_rows(maximum_fixture, """
    update room_sessions
    set created_at = now() - interval '2 minutes',
        deadline_at = now() - interval '1 second',
        maximum_duration_seconds = 119,
        deadline_generation = 2
    where tenant_id = $1 and id = $2
    """)

    maximum_end =
      operation("maximum_end_op_01", :maximum_duration_expired, %{
        "deadlineGeneration" => 2
      })

    assert {:ok, %{external_operation_id: maximum_id}} =
             Postgres.begin_internal_operation(maximum_fixture.session, maximum_end)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(maximum_fixture.session, maximum_id, {
               :applied,
               :session_ended,
               %{"reason" => "maximum_duration"}
             })

    assert [["maximum_duration"]] =
             query_rows(
               maximum_fixture,
               """
               select payload->>'reason'
               from sync_control_events
               where tenant_id = $1 and session_id = $2
                 and external_operation_id = $3
               """,
               [UUID.dump!(maximum_id)]
             )
  end

  defp operation(request_key, name, payload) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    operation
  end

  defp query_rows(fixture, sql, extra_params \\ []) do
    params =
      [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)] ++
        extra_params

    Postgrex.query!(ChalkSync.Database.connection(fixture.session), sql, params).rows
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
