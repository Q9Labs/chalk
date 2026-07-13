defmodule ChalkSync.Stateholder.PostgresLifecycleTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

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

  @tag :host_exit
  test "host Leave is rejected when transfer is required", %{connections: connections} do
    fixture = SyncPostgres.seed_session(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    host = hd(fixture.identities)
    {:ok, leave} = Operation.new("host_leave_reject01", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :host_transfer_required}} =
             Postgres.begin_operation(host, leave)

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)

    assert recovery.snapshot["host_participant_session_id"] ==
             hd(fixture.identities).participant_session_id
  end

  @tag :host_exit
  test "host Leave promotes the longest-tenured cohost in one fact", %{
    connections: connections
  } do
    fixture =
      SyncPostgres.seed_session(hd(connections), 2, %{host_exit_policy: "promote_cohost"})

    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [host, successor] = fixture.identities
    connection = hd(connections)

    Postgrex.query!(
      connection,
      "update participants set role = 'cohost' where tenant_id = $1 and id = $2",
      [UUID.dump!(fixture.session.tenant_id), UUID.dump!(successor.participant_session_id)]
    )

    state =
      put_in(
        fixture.state,
        [Access.key(:participants), successor.participant_session_id, :role],
        "cohost"
      )

    Postgrex.query!(
      connection,
      """
      update sync_session_control
      set folded_state = $3, state_digest = $4, snapshot_bytes = $5
      where tenant_id = $1 and session_id = $2
      """,
      [
        UUID.dump!(fixture.session.tenant_id),
        UUID.dump!(fixture.session.session_id),
        Reducer.snapshot(state),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state)
      ]
    )

    fixture =
      fixture
      |> Map.put(:identity, host)
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    {:ok, operation} = Operation.new("host_leave_webhook_01", :participant_leave, %{})
    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, operation)

    outcome =
      {:applied, :host_left_and_transferred,
       %{
         "departing_participant_session_id" => host.participant_session_id,
         "successor_participant_session_id" => successor.participant_session_id
       }}

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, pending.external_operation_id, outcome)

    assert [["participant.left", "left"]] =
             query_rows(fixture, """
             select event_name, convert_from(body, 'UTF8')::jsonb->'data'->'object'->>'status'
             from webhook_events
             where tenant_id = $1 and $2::uuid is not null
             """)

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.snapshot["host_participant_session_id"] == successor.participant_session_id

    refute Enum.any?(recovery.snapshot["participants"], fn participant ->
             participant["participant_session_id"] == host.participant_session_id
           end)
  end

  test "applies a pending admission atomically and resolves every retry", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    assert {:ok, before_apply} = Postgres.recover(fixture.identity, nil)
    assert before_apply.mode == :terminal
    assert before_apply.terminal_reason == :participant_inactive

    assert {:ok, applied} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert applied.result == :applied
    assert applied.revision == 1
    assert applied.event.name == "participant_joined"
    assert applied.event.lifecycle_intent_id == fixture.lifecycle_intent_id

    assert {:ok, duplicate} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert duplicate.result == :already_applied
    assert duplicate.event_id == applied.event_id
    assert duplicate.revision == applied.revision

    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    assert recovery.mode == :snapshot
    assert recovery.head.revision == 1

    assert hd(recovery.snapshot["participants"])["participant_session_id"] ==
             fixture.identity.participant_session_id

    assert [
             [0, 2, 32_768, 2, 32_768, "active"]
           ] =
             query_rows(fixture, """
             select
               c.snapshot_reserved_bytes,
               c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes,
               c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes,
               p.status
             from sync_session_control c
             join participants p
               on p.tenant_id = c.tenant_id and p.session_id = c.session_id
             where c.tenant_id = $1 and c.session_id = $2
             """)
  end

  test "discovers and applies an approval request without granting participant authority", %{
    connections: connections
  } do
    connection = hd(connections)

    fixture = SyncPostgres.seed_session(connection)

    fixture =
      SyncPostgres.seed_admission_request(connection, fixture, request_status: :pending)

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    assert {:ok, pending} = Postgres.pending_lifecycle_intents(32)

    assert {fixture.session, fixture.admission_requested_intent_id} in pending

    refute Enum.any?(pending, fn {_session, intent_id} ->
             intent_id == fixture.admission_join_intent_id
           end)

    assert {:ok, applied} =
             Postgres.apply_lifecycle_intent(
               fixture.session,
               fixture.admission_requested_intent_id
             )

    assert applied.result == :applied
    assert applied.revision == 2
    assert applied.event.name == "admission_requested"
    assert applied.event.payload == fixture.admission_payload

    assert {:ok, duplicate} =
             Postgres.apply_lifecycle_intent(
               fixture.session,
               fixture.admission_requested_intent_id
             )

    assert duplicate.result == :already_applied
    assert duplicate.event_id == applied.event_id

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.mode == :snapshot
    assert recovery.head.revision == 2

    assert recovery.snapshot["admission_requests"] == [fixture.admission_payload]

    refute Enum.any?(recovery.snapshot["participants"], fn participant ->
             participant["participant_session_id"] == fixture.admission_participant_id
           end)

    assert {:error, :participant_inactive} =
             Postgres.participant_authority(fixture.session, fixture.admission_participant_id, 1)

    assert [["pending", "joining", 2, 4, 65_536, 2_048, 0, 0]] =
             query_rows(fixture, """
             select a.status, p.status, c.control_revision,
               c.lifecycle_reserved_events, c.lifecycle_reserved_bytes,
               c.snapshot_reserved_bytes,
               (select count(*) from webhook_events where tenant_id = $1),
               (select count(*) from webhook_deliveries where tenant_id = $1)
             from sync_admission_requests a
             join participants p on p.id = a.participant_session_id
             join sync_session_control c
               on c.tenant_id = a.tenant_id and c.session_id = a.session_id
             where a.tenant_id = $1 and a.session_id = $2
             """)

    assert {:ok, remaining} = Postgres.pending_lifecycle_intents(32)

    refute Enum.any?(remaining, fn {_session, intent_id} ->
             intent_id in [
               fixture.admission_requested_intent_id,
               fixture.admission_join_intent_id
             ]
           end)

    assert [["pending", true]] =
             query_rows(
               fixture,
               """
               select status, next_attempt_at = 'infinity'::timestamptz
               from sync_lifecycle_intents
               where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
               """,
               [UUID.dump!(fixture.admission_join_intent_id)]
             )
  end

  test "rejects malformed and mismatched approval request payloads without folding authority", %{
    connections: connections
  } do
    connection = hd(connections)

    fixtures =
      for mutation <- [:malformed, :mismatched] do
        fixture = SyncPostgres.seed_session(connection)

        fixture =
          SyncPostgres.seed_admission_request(connection, fixture, request_status: :pending)

        on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

        payload =
          case mutation do
            :malformed ->
              Map.put(fixture.admission_payload, "participant_session_id", "invalid")

            :mismatched ->
              Map.put(fixture.admission_payload, "display_name", "Different Participant")
          end

        Postgrex.query!(
          connection,
          """
          update sync_lifecycle_intents
          set payload = $2
          where lifecycle_intent_id = $1
          """,
          [UUID.dump!(fixture.admission_requested_intent_id), payload]
        )

        {mutation, fixture}
      end

    for {mutation, fixture} <- fixtures do
      expected_error =
        if mutation == :malformed,
          do: :invalid_lifecycle_intent,
          else: :invalid_lifecycle_transition

      assert {:error, ^expected_error} =
               Postgres.apply_lifecycle_intent(
                 fixture.session,
                 fixture.admission_requested_intent_id
               )

      assert {:error, :participant_inactive} =
               Postgres.participant_authority(
                 fixture.session,
                 fixture.admission_participant_id,
                 1
               )

      assert [[1, "pending", "joining", 0]] =
               query_rows(
                 fixture,
                 """
                 select c.control_revision, i.status, p.status,
                   count(e.event_id) filter (where e.lifecycle_intent_id = i.lifecycle_intent_id)
                 from sync_session_control c
                 join sync_lifecycle_intents i
                   on i.tenant_id = c.tenant_id and i.session_id = c.session_id
                 join participants p
                   on p.tenant_id = c.tenant_id and p.session_id = c.session_id
                 left join sync_control_events e
                   on e.tenant_id = i.tenant_id and e.session_id = i.session_id
                 where c.tenant_id = $1 and c.session_id = $2
                   and i.lifecycle_intent_id = $3
                   and p.id = $4
                 group by c.control_revision, i.status, p.status
                 """,
                 [
                   UUID.dump!(fixture.admission_requested_intent_id),
                   UUID.dump!(fixture.admission_participant_id)
                 ]
               )
    end
  end

  test "concurrent nodes apply one lifecycle event", %{connections: connections} do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)
      end)

    outcomes = Enum.map([Task.await(first), Task.await(second)], fn {:ok, result} -> result end)
    assert outcomes |> Enum.map(& &1.result) |> Enum.sort() == [:already_applied, :applied]
    assert Enum.uniq(Enum.map(outcomes, & &1.event_id)) |> length() == 1

    assert [[1]] =
             query_rows(
               fixture,
               "select count(*) from sync_control_events where tenant_id = $1 and session_id = $2"
             )
  end

  test "participant removal consumes its reserve and becomes terminal for the old token", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [host, participant] = fixture.identities

    {:ok, remove} =
      Operation.new("participant_remove01", :remove_participant, %{
        "participantSessionId" => participant.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, remove)

    assert {:ok, %{result: :applied, revision: 3}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :participant_left,
               %{
                 "participant_session_id" => participant.participant_session_id,
                 "reason" => "removed"
               }
             })

    assert {:ok, terminal} = Postgres.recover(participant, nil)
    assert terminal.mode == :terminal
    assert terminal.terminal_reason == :participant_inactive
    assert terminal.head.revision == 3

    assert [["left", 1]] =
             query_rows(
               fixture,
               """
               select p.status,
                 count(*) filter (where active.status in ('joining', 'active', 'leaving'))
               from participants p
               join participants active
                 on active.tenant_id = p.tenant_id and active.session_id = p.session_id
               where p.tenant_id = $1 and p.session_id = $2 and p.id = $3
               group by p.status
               """,
               [UUID.dump!(participant.participant_session_id)]
             )
  end

  test "session end supersedes pending joins and releases every lifecycle reserve", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    fixture = SyncPostgres.seed_admission_request(hd(connections), fixture)
    host = hd(fixture.identities)
    {:ok, ending} = Operation.new("session_end_external1", :end_session, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, ending)

    assert {:ok, %{result: :applied, revision: 3}} =
             Postgres.finalize_operation(fixture.session, operation_id, {
               :applied,
               :session_ended,
               %{"reason" => "ended_by_participant"}
             })

    assert {:ok, terminal} = Postgres.recover(fixture.session, nil)
    assert terminal.mode == :terminal
    assert terminal.terminal_reason == :session_ended
    assert terminal.head.revision == 3

    assert [[0, 0, 0, 0, 0, "ended", 0]] =
             query_rows(fixture, """
             select
               c.snapshot_reserved_bytes,
               c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes,
               c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes,
               s.status,
               count(p.id) filter (where p.status <> 'left')
             from sync_session_control c
             join room_sessions s
               on s.tenant_id = c.tenant_id and s.id = c.session_id
             left join participants p
               on p.tenant_id = c.tenant_id and p.session_id = c.session_id
             where c.tenant_id = $1 and c.session_id = $2
             group by c.snapshot_reserved_bytes, c.lifecycle_reserved_events,
               c.lifecycle_reserved_bytes, c.lifecycle_reserved_intents,
               c.lifecycle_reserved_intent_bytes, s.status
             """)

    assert [["superseded", "superseded_by_session_end"]] =
             query_rows(
               fixture,
               """
               select status, terminal_reason
               from sync_lifecycle_intents
               where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
               """,
               [UUID.dump!(fixture.admission_join_intent_id)]
             )
  end

  test "resolves lifecycle success after the commit response is lost", %{connections: connections} do
    fixture = SyncPostgres.seed_pending_join(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)

    Application.put_env(:chalk_sync, :lifecycle_fault_hook, fn point, _context ->
      if point == :after_commit_before_reply, do: raise("lost lifecycle commit response")
    end)

    try do
      assert {:ok, decision} =
               Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

      assert decision.result == :already_applied
      assert decision.revision == 1
    after
      Application.delete_env(:chalk_sync, :lifecycle_fault_hook)
    end
  end

  test "fans one joined Event out to every matching immutable Target Revision", %{
    connections: connections
  } do
    connection = hd(connections)

    fixture =
      connection
      |> SyncPostgres.seed_pending_join()
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.joined"])
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.joined", "participant.left"])
      |> SyncPostgres.seed_webhook_endpoint(connection, ["session.ended"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert [["participant.joined", 1, 2, 1, 1, journey_id, parent_id]] =
             query_rows(
               fixture,
               """
               select e.event_name, e.api_version, count(d.id),
                 min(d.endpoint_revision), max(d.endpoint_revision),
                 e.journey_id, e.parent_journey_event_id
               from webhook_events e
               join webhook_deliveries d
                 on d.tenant_id = e.tenant_id and d.event_id = e.id
               where e.tenant_id = $1
                 and $2::uuid is not null
                 and e.resource_id = $3
               group by e.id
               """,
               [UUID.dump!(fixture.identity.participant_session_id)]
             )

    assert UUID.load!(journey_id) == fixture.journey_id
    assert UUID.load!(parent_id) == fixture.parent_journey_event_id
    parent_journey_event_id = UUID.dump!(fixture.parent_journey_event_id)

    assert [
             ["webhook.event.committed", ^parent_journey_event_id],
             ["webhook.delivery.queued", committed_id],
             [
               "webhook.delivery.queued",
               committed_id
             ]
           ] =
             query_rows(
               fixture,
               """
               select name, parent_event_id
               from observability_journey_events
               where $1::uuid is not null
                 and $2::uuid is not null
                 and journey_id = $3
               order by sequence
               """,
               [UUID.dump!(fixture.journey_id)]
             )

    assert is_binary(committed_id)
  end

  test "first Endpoint create and producer serialize through the tenant row", %{
    connections: connections
  } do
    [endpoint_connection, producer_connection | _] = connections
    fixture = SyncPostgres.seed_session(endpoint_connection)
    on_exit(fn -> SyncPostgres.cleanup(endpoint_connection, fixture.session) end)
    parent = self()

    endpoint_task =
      Task.async(fn ->
        Postgrex.transaction(endpoint_connection, fn transaction ->
          tenant_id = UUID.dump!(fixture.session.tenant_id)

          Postgrex.query!(
            transaction,
            "insert into webhook_tenant_state (tenant_id) values ($1) on conflict do nothing",
            [tenant_id]
          )

          Postgrex.query!(
            transaction,
            "select tenant_id from webhook_tenant_state where tenant_id = $1 for update",
            [tenant_id]
          )

          send(parent, :endpoint_tenant_locked)
          receive do: (:finish_endpoint_create -> :ok)

          SyncPostgres.insert_webhook_endpoint(transaction, fixture.session, [
            "participant.joined"
          ])
        end)
      end)

    assert_receive :endpoint_tenant_locked
    identity = hd(fixture.identities)
    joined_at = datetime("2026-07-12T18:05:00.123456Z")

    producer_task =
      Task.async(fn ->
        Postgrex.transaction(producer_connection, fn transaction ->
          WebhookProducer.produce(
            transaction,
            fixture.session,
            webhook_intent("participant_joined"),
            participant_object(fixture, identity, "active", joined_at, nil)
          )
        end)
      end)

    assert Task.yield(producer_task, 100) == nil
    send(endpoint_task.pid, :finish_endpoint_create)
    assert {:ok, _endpoint_id} = Task.await(endpoint_task)
    assert {:ok, :ok} = Task.await(producer_task)

    assert [[1, 1]] =
             query_rows(fixture, """
             select count(e.id), count(d.id)
             from webhook_events e
             join webhook_deliveries d on d.tenant_id = e.tenant_id and d.event_id = e.id
             where e.tenant_id = $1 and $2::uuid is not null
             """)
  end

  test "semantic occurrence fields, not updated_at, drive normalized persistence", %{
    connections: connections
  } do
    connection = hd(connections)
    seed = SyncPostgres.seed_session(connection)

    fixture =
      %{session: seed.session, identity: hd(seed.identities)}
      |> SyncPostgres.seed_webhook_endpoint(connection, [
        "participant.joined",
        "participant.left",
        "session.ended"
      ])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)
    joined_at = datetime("2026-07-12T18:05:00.123456Z")
    left_at = datetime("2026-07-12T19:05:00.234567Z")
    ended_at = datetime("2026-07-12T20:05:00.345678Z")
    updated_at = datetime("2026-07-12T23:59:59.999999Z")

    objects = [
      {"participant_joined",
       participant_object(fixture, fixture.identity, "active", joined_at, nil)},
      {"participant_left",
       participant_object(fixture, fixture.identity, "left", joined_at, left_at)},
      {"session_ended",
       %{
         id: fixture.session.session_id,
         room_id: fixture.session.room_id,
         status: "ended",
         started_at: joined_at,
         ended_at: ended_at,
         created_at: joined_at,
         updated_at: updated_at
       }}
    ]

    Enum.each(objects, fn {name, object} ->
      object = Map.put(object, :updated_at, updated_at)

      {:ok, :ok} =
        Postgrex.transaction(connection, fn transaction ->
          WebhookProducer.produce(
            transaction,
            fixture.session,
            webhook_intent(name),
            object
          )
        end)
    end)

    assert [
             ["participant.joined", joined_persisted, joined_body],
             ["participant.left", left_persisted, left_body],
             ["session.ended", ended_persisted, ended_body]
           ] =
             query_rows(fixture, """
             select event_name, occurred_at, body
             from webhook_events
             where tenant_id = $1 and $2::uuid is not null
             order by event_name
             """)

    assert_occurrence(joined_persisted, joined_body, "2026-07-12T18:05:00.123Z")
    assert_occurrence(left_persisted, left_body, "2026-07-12T19:05:00.234Z")
    assert_occurrence(ended_persisted, ended_body, "2026-07-12T20:05:00.345Z")
  end

  test "invalid webhook snapshot aborts producer persistence", %{connections: connections} do
    connection = hd(connections)
    seed = SyncPostgres.seed_session(connection)

    fixture =
      %{session: seed.session, identity: hd(seed.identities)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.joined"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)
    joined_at = datetime("2026-07-12T18:05:00.123456Z")

    invalid_object =
      fixture
      |> participant_object(fixture.identity, "active", joined_at, nil)
      |> Map.put(:id, nil)

    assert_raise ArgumentError, fn ->
      Postgrex.transaction(connection, fn transaction ->
        WebhookProducer.produce(
          transaction,
          fixture.session,
          webhook_intent("participant_joined"),
          invalid_object
        )
      end)
    end

    assert [[0, 0]] =
             query_rows(fixture, """
             select
               (select count(*) from webhook_events where tenant_id = $1),
               (select count(*) from webhook_deliveries where tenant_id = $1)
             where $2::uuid is not null
             """)
  end

  test "observed external leave and end continue their durable journey and trace", %{
    connections: connections
  } do
    test_pid = self()
    handler_id = "postgres-webhook-observability-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:chalk_sync, :observability, :event],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:telemetry_event, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    connection = hd(connections)
    leave_seed = SyncPostgres.seed_session(connection, 2)
    end_seed = SyncPostgres.seed_session(connection)

    leave_fixture =
      %{session: leave_seed.session, identity: Enum.at(leave_seed.identities, 1)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    end_fixture =
      %{session: end_seed.session, identity: hd(end_seed.identities)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["session.ended"])

    on_exit(fn -> SyncPostgres.cleanup(connection, leave_fixture.session) end)
    on_exit(fn -> SyncPostgres.cleanup(connection, end_fixture.session) end)

    leave_context = observed_context(1)
    end_context = observed_context(2)

    leave_identity = %{leave_fixture.identity | protocol_version: 3}
    end_identity = %{end_fixture.identity | protocol_version: 3}

    leave_operation =
      observed_operation("observed_leave_0001", :participant_leave, %{}, leave_context)

    end_operation = observed_operation("observed_end_000001", :end_session, %{}, end_context)

    assert {:ok, leave_pending} = Postgres.begin_operation(leave_identity, leave_operation)
    assert {:ok, end_pending} = Postgres.begin_operation(end_identity, end_operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               leave_fixture.session,
               leave_pending.external_operation_id,
               leave_outcome(leave_identity)
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               end_fixture.session,
               end_pending.external_operation_id,
               {:applied, :session_ended, %{"reason" => "ended_by_participant"}}
             )

    assert_journey_continuity(leave_fixture, "participant.left", leave_context)
    assert_journey_continuity(end_fixture, "session.ended", end_context)

    assert {:ok, stored_leave} =
             Postgres.read_operation(
               leave_fixture.session,
               leave_pending.external_operation_id
             )

    assert stored_leave.journey_id == leave_context.journey_id
    assert stored_leave.parent_journey_event_id == leave_context.parent_journey_event_id
    assert stored_leave.producing_trace_id == leave_context.producing_trace_id
    assert stored_leave.producing_span_id == leave_context.producing_span_id

    assert_post_commit_observation(leave_context.journey_id)
    assert_post_commit_observation(end_context.journey_id)
  end

  test "contextless internal end creates a background webhook root", %{connections: connections} do
    connection = hd(connections)
    seed = SyncPostgres.seed_session(connection)

    fixture =
      %{session: seed.session, identity: hd(seed.identities)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["session.ended"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)
    {:ok, operation} = Operation.new("internal_end_000001", :tenant_end_session, %{})
    assert {:ok, pending} = Postgres.begin_internal_operation(fixture.session, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               pending.external_operation_id,
               {:applied, :session_ended, %{"reason" => "tenant_recovery"}}
             )

    assert [["background_worker", "unknown", nil, nil]] =
             query_rows(fixture, """
             select j.origin_kind, j.upstream_visibility, e.producing_trace_id, e.producing_span_id
             from webhook_events e
             join observability_journey_events j
               on j.journey_id = e.journey_id and j.name = 'webhook.event.committed'
             where e.tenant_id = $1 and $2::uuid is not null
             """)
  end

  test "joined, left, and ended each create one Event while retry and recovery stay silent", %{
    connections: connections
  } do
    connection = hd(connections)

    fixture =
      connection
      |> SyncPostgres.seed_pending_join()
      |> SyncPostgres.seed_webhook_endpoint(connection, [
        "participant.joined",
        "participant.left",
        "session.ended"
      ])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    leave_seed = SyncPostgres.seed_session(connection, 2)

    leave_fixture =
      %{
        session: leave_seed.session,
        identity: Enum.at(leave_seed.identities, 1)
      }
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    end_seed = SyncPostgres.seed_session(connection)

    end_fixture =
      %{
        session: end_seed.session,
        identity: hd(end_seed.identities)
      }
      |> SyncPostgres.seed_webhook_endpoint(connection, ["session.ended"])

    on_exit(fn -> SyncPostgres.cleanup(connection, leave_fixture.session) end)
    on_exit(fn -> SyncPostgres.cleanup(connection, end_fixture.session) end)

    assert {:ok, joined} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert {:ok, duplicate} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert duplicate.result == :already_applied
    assert duplicate.event_id == joined.event_id
    assert {:ok, _recovery} = Postgres.recover(fixture.identity, nil)

    assert {{:ok, %{result: :applied}}, leave_operation_id} = finalize_leave(leave_fixture)
    assert {{:ok, %{result: :applied}}, end_operation_id} = finalize_end(end_fixture)

    assert [["participant.joined"]] =
             query_rows(fixture, """
             select event_name
             from webhook_events
             where tenant_id = $1
               and $2::uuid is not null
             order by case event_name
               when 'participant.joined' then 1
               when 'participant.left' then 2
               when 'session.ended' then 3
             end
             """)

    assert [[1, 1]] =
             query_rows(fixture, """
             select count(distinct e.id), count(d.id)
             from webhook_events e
             join webhook_deliveries d
               on d.tenant_id = e.tenant_id and d.event_id = e.id
             where e.tenant_id = $1 and $2::uuid is not null
               and e.event_name = 'participant.joined'
             """)

    assert [["participant.left", leave_transition_key, "background_worker", "unknown"]] =
             query_rows(leave_fixture, """
             select e.event_name, e.semantic_transition_key,
               j.origin_kind, j.upstream_visibility
             from webhook_events e
             join observability_journey_events j
               on j.journey_id = e.journey_id and j.name = 'webhook.event.committed'
             where e.tenant_id = $1 and $2::uuid is not null
             """)

    assert leave_transition_key ==
             "sync_external:#{leave_operation_id}:participant.left"

    assert [["session.ended", end_transition_key, "background_worker", "unknown"]] =
             query_rows(end_fixture, """
             select e.event_name, e.semantic_transition_key,
               j.origin_kind, j.upstream_visibility
             from webhook_events e
             join observability_journey_events j
               on j.journey_id = e.journey_id and j.name = 'webhook.event.committed'
             where e.tenant_id = $1 and $2::uuid is not null
             """)

    assert end_transition_key == "sync_external:#{end_operation_id}:session.ended"
  end

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

    seed = SyncPostgres.seed_session(connection, 2)

    fixture =
      %{session: seed.session, identity: Enum.at(seed.identities, 1)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    {:ok, operation} = Operation.new("webhook_rollback_01", :participant_leave, %{})

    assert {:ok, %{result: :pending} = pending} =
             Postgres.begin_operation(fixture.identity, operation)

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("injected webhook rollback")
    end)

    try do
      assert {:retryable, :decision_unavailable} =
               Postgres.finalize_operation(
                 fixture.session,
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
                 on o.tenant_id = p.tenant_id and o.target_participant_session_id = p.id
               join sync_session_control c
                 on c.tenant_id = p.tenant_id and c.session_id = p.session_id
               where p.tenant_id = $1 and p.session_id = $2 and p.id = $3
               """,
               [UUID.dump!(fixture.identity.participant_session_id)]
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
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
               fixture.session,
               pending.external_operation_id,
               leave_outcome(fixture.identity)
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50
  end

  test "unrelated subscriptions emit no participant Event", %{
    connections: connections
  } do
    connection = hd(connections)

    fixture =
      connection
      |> SyncPostgres.seed_pending_join()
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert [[0, 0]] =
             query_rows(fixture, """
             select
               (select count(*) from webhook_events where tenant_id = $1),
               (select count(*) from webhook_deliveries where tenant_id = $1)
             where $2::uuid is not null
             """)
  end

  test "an old intent without journey context starts an explicit background root", %{
    connections: connections
  } do
    connection = hd(connections)

    fixture =
      connection
      |> SyncPostgres.seed_pending_join()
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.joined"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    query_rows(
      fixture,
      """
      update sync_lifecycle_intents
      set journey_id = null, parent_journey_event_id = null
      where tenant_id = $1 and session_id = $2
      returning lifecycle_intent_id
      """
    )

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert [["background_worker", "unknown", nil]] =
             query_rows(fixture, """
             select origin_kind, upstream_visibility, parent_event_id
             from observability_journey_events
             where journey_id = (
               select journey_id from webhook_events where tenant_id = $1 limit 1
             )
               and $2::uuid is not null
             order by sequence
             limit 1
             """)
  end

  defp query_rows(fixture, sql, extra_params \\ []) do
    params =
      [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)] ++
        extra_params

    Database.connection(fixture.session)
    |> Postgrex.query!(sql, params)
    |> Map.fetch!(:rows)
  end

  defp finalize_leave(%{identity: identity, session: session}) do
    {:ok, operation} = Operation.new("webhook_leave_op_01", :participant_leave, %{})
    {:ok, pending} = Postgres.begin_operation(identity, operation)

    result =
      Postgres.finalize_operation(session, pending.external_operation_id, leave_outcome(identity))

    {result, pending.external_operation_id}
  end

  defp leave_outcome(identity) do
    {:applied, :participant_left,
     %{
       "participant_session_id" => identity.participant_session_id,
       "reason" => "left"
     }}
  end

  defp finalize_end(%{identity: identity, session: session}) do
    {:ok, operation} = Operation.new("webhook_end_op_0001", :end_session, %{})
    {:ok, pending} = Postgres.begin_operation(identity, operation)

    result =
      Postgres.finalize_operation(
        session,
        pending.external_operation_id,
        {:applied, :session_ended, %{"reason" => "ended_by_participant"}}
      )

    {result, pending.external_operation_id}
  end

  defp webhook_intent(name) do
    %{
      id: UUID.generate(),
      name: name,
      journey_id: nil,
      parent_journey_event_id: nil,
      producing_trace_id: nil,
      producing_span_id: nil
    }
  end

  defp participant_object(fixture, identity, status, joined_at, left_at) do
    %{
      id: identity.participant_session_id,
      user_id: nil,
      room_id: fixture.session.room_id,
      session_id: fixture.session.session_id,
      name: "Participant",
      status: status,
      joined_at: joined_at,
      left_at: left_at,
      updated_at: datetime("2026-07-12T23:59:59.999999Z")
    }
  end

  defp assert_occurrence(persisted, body, expected) do
    assert DateTime.compare(persisted, datetime(expected)) == :eq
    assert body |> JSON.decode!() |> Map.fetch!("occurred_at") == expected
  end

  defp observed_context(_index) do
    {:ok, context} =
      ObservedContext.new(
        UUID.generate(),
        UUID.generate(),
        random_hex(16),
        random_hex(8),
        datetime("2026-07-12T18:05:00.000Z")
      )

    context
  end

  defp assert_post_commit_observation(journey_id) do
    receive do
      {:telemetry_event, [:chalk_sync, :observability, :event], %{count: 1}, metadata} ->
        if metadata.event == "sync.webhook.production.committed" and
             metadata.journey_id == journey_id do
          assert metadata.stage == "phase"

          assert metadata.attributes.api_version == 1
          assert metadata.attributes.event_name in ["participant.left", "session.ended"]
          assert metadata.attributes.producer == "sync"
          assert metadata.attributes.transition == "external_operation"
        else
          assert_post_commit_observation(journey_id)
        end
    after
      500 -> flunk("expected post-commit webhook observation for journey #{journey_id}")
    end
  end

  defp observed_operation(request_key, name, payload, context) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    Operation.observe(operation, context)
  end

  defp assert_journey_continuity(fixture, event_name, context) do
    assert [[journey_id, parent_id, trace_id, span_id]] =
             query_rows(
               fixture,
               """
               select journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
               from webhook_events
               where tenant_id = $1 and $2::uuid is not null and event_name = $3
               """,
               [event_name]
             )

    assert UUID.load!(journey_id) == context.journey_id
    assert UUID.load!(parent_id) == context.parent_journey_event_id
    assert trace_id == context.producing_trace_id
    assert span_id == context.producing_span_id
    parent_id = UUID.dump!(context.parent_journey_event_id)

    assert [
             ["sync.external_operation.accepted", nil],
             ["webhook.event.committed", ^parent_id],
             ["webhook.delivery.queued", queued_parent]
           ] =
             query_rows(
               fixture,
               """
               select name, parent_event_id
               from observability_journey_events
               where journey_id = $3 and $1::uuid is not null and $2::uuid is not null
               order by sequence
               """,
               [UUID.dump!(context.journey_id)]
             )

    assert is_binary(queued_parent)
    refute queued_parent == parent_id
  end

  defp random_hex(bytes), do: bytes |> :crypto.strong_rand_bytes() |> Base.encode16(case: :lower)

  defp datetime(value), do: value |> DateTime.from_iso8601() |> elem(1)

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
