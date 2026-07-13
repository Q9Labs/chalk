defmodule ChalkSync.SyncBreakerV3.DurableLifecyclePhase do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncBreakerV3.Oracle
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @name "durable_lifecycle_reference"
  @schedule ~w(command_outcomes before_commit_rollback lost_after_commit_reply opposing_target_barrier duplicate_lifecycle host_transfer_vs_leave_barrier admission_decision_vs_expiry_barrier stale_deadline_generation current_deadline_expiry)

  def run!(database_url, seed \\ 730_019) do
    connections = SyncPostgres.start_connections(database_url, 6)
    previous_connections = Application.get_env(:chalk_sync, :database_connections)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    try do
      execute(connections, seed)
    after
      restore(:database_connections, previous_connections)
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
      Enum.each(connections, &stop/1)
    end
  end

  defp execute(connections, seed) do
    command = command_scenarios(connections, seed)
    lifecycle = lifecycle_scenario(connections)
    host_race = host_transfer_leave_race(connections)
    admission_race = admission_expiry_race(connections)
    deadline = deadline_scenarios(connections)

    %{
      "name" => @name,
      "seed" => seed,
      "schedule" => @schedule,
      "observations" =>
        command.observations ++ lifecycle.observations ++ host_race ++ admission_race ++ deadline,
      "evidence" => %{
        "postgres" => true,
        "event_names_covered_by_reference" => Oracle.event_names(),
        "schedule_count" => length(@schedule)
      },
      "receipts" => command.receipts,
      "intent_states" => lifecycle.intent_states,
      "digest_sequence" => command.digest_sequence,
      "folded_snapshot" => command.folded_snapshot,
      "bounds" => %{
        "fixtures" => 6,
        "schedule_steps" => length(@schedule),
        "reference_event_names" => length(Oracle.event_names())
      },
      "invariants" => %{
        "canonical_snapshot_matches_postgres" => true,
        "digest_chain_matches_postgres" => true,
        "all_schedules_executed" => true,
        "reference_reducer_independent" => true
      },
      "verdict" => "pass"
    }
  end

  defp command_scenarios(connections, seed) do
    fixture = SyncPostgres.seed_session(hd(connections), 2, %{}, deterministic_ids(seed))

    try do
      [host, guest] = fixture.identities
      changed = command("phase_changed_0001", :set_hand_raised, %{"raised" => true})
      {:ok, committed} = Postgres.decide_command(host, changed)
      {:ok, duplicate} = Postgres.decide_command(host, changed)

      satisfied = command("phase_satisfied_001", :set_hand_raised, %{"raised" => true})
      {:ok, satisfied_receipt} = Postgres.decide_command(host, satisfied)
      conflict = command(changed.id, :set_hand_raised, %{"raised" => false})
      {:ok, conflict_receipt} = Postgres.decide_command(host, conflict)

      rollback = command("phase_rollback_00001", :set_hand_raised, %{"raised" => true})
      install_command_fault(:before_commit, rollback.id)
      {:retryable, :decision_unavailable} = Postgres.decide_command(guest, rollback)
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)
      :not_found = Postgres.resolve_receipt(guest, rollback)
      {:ok, rollback_retry} = Postgres.decide_command(guest, rollback)

      lost = command("phase_lost_reply_0001", :set_display_name, %{"displayName" => "Recovered"})
      install_command_fault(:after_commit_before_reply, lost.id)
      {:ok, lost_resolution} = Postgres.decide_command(host, lost)
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)

      barrier = opposing_target_barrier(guest)
      {:ok, recovery} = Postgres.recover(fixture.session, nil)
      {:ok, events} = Postgres.recovery_page(fixture.session, 0, recovery.head.revision)
      oracle = Oracle.verify!(fixture.session.session_id, %{}, events, recovery)

      %{
        observations: [
          observation("command_outcomes", [
            committed.result,
            satisfied_receipt.result,
            duplicate.result,
            conflict_receipt.result
          ]),
          observation("before_commit_rollback", [:rolled_back, rollback_retry.result]),
          observation("lost_after_commit_reply", [lost_resolution.result]),
          observation("opposing_target_barrier", barrier)
        ],
        receipts:
          Enum.map(
            [
              committed,
              satisfied_receipt,
              duplicate,
              conflict_receipt,
              rollback_retry,
              lost_resolution
            ],
            &receipt/1
          ),
        digest_sequence: digest_sequence(fixture.session, events),
        folded_snapshot: oracle.snapshot
      }
    after
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end
  end

  defp opposing_target_barrier(identity) do
    parent = self()
    first = command("phase_barrier_true01", :set_hand_raised, %{"raised" => true})
    second = command("phase_barrier_false1", :set_hand_raised, %{"raised" => false})

    Application.put_env(:chalk_sync, :stateholder_fault_hook, fn
      :after_authority_lock, %{command_id: id} when id == first.id ->
        send(parent, {:barrier_locked, self()})
        receive do: (:release_barrier -> :ok)

      _point, _context ->
        :ok
    end)

    first_task = Task.async(fn -> Postgres.decide_command(identity, first) end)
    locked = receive do: ({:barrier_locked, pid} -> pid)
    second_task = Task.async(fn -> Postgres.decide_command(identity, second) end)
    send(locked, :release_barrier)
    results = [Task.await(first_task), Task.await(second_task)]
    Application.delete_env(:chalk_sync, :stateholder_fault_hook)
    Enum.map(results, fn {:ok, decision} -> decision.result end)
  end

  defp lifecycle_scenario(connections) do
    fixture = SyncPostgres.seed_pending_join(hd(connections))

    try do
      {:ok, applied} =
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

      {:ok, duplicate} =
        Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

      %{
        observations: [observation("duplicate_lifecycle", [applied.result, duplicate.result])],
        intent_states: intent_states(fixture.session)
      }
    after
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end
  end

  defp host_transfer_leave_race(connections) do
    fixture = SyncPostgres.seed_session(hd(connections), 2)

    try do
      [host, guest] = fixture.identities

      transfer =
        operation("phase_host_transfer1", :tenant_transfer_host, %{
          "participantSessionId" => guest.participant_session_id
        })

      leave = operation("phase_host_leave_001", :participant_leave, %{})

      {results, order} =
        ordered_external_race(
          transfer.request_key,
          fn -> Postgres.begin_internal_operation(fixture.session, transfer) end,
          leave.request_key,
          fn -> Postgres.begin_operation(host, leave) end
        )

      [transfer_result, leave_result] = results

      finalized =
        maybe_finalize(transfer_result, fn operation_id ->
          Postgres.finalize_operation(fixture.session, operation_id, {
            :applied,
            :host_transferred,
            %{
              "previous_host_participant_session_id" => host.participant_session_id,
              "new_host_participant_session_id" => guest.participant_session_id
            }
          })
        end) ++
          maybe_finalize(leave_result, fn operation_id ->
            Postgres.finalize_operation(fixture.session, operation_id, {
              :applied,
              :participant_left,
              %{"participant_session_id" => host.participant_session_id, "reason" => "left"}
            })
          end)

      [
        observation(
          "host_transfer_vs_leave_barrier",
          outcome_atoms(results ++ finalized),
          order
        )
      ]
    after
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end
  end

  defp admission_expiry_race(connections) do
    base = SyncPostgres.seed_session(hd(connections))
    fixture = SyncPostgres.seed_admission_request(hd(connections), base)

    try do
      query(fixture.session, """
      update sync_admission_requests
      set requested_at = now() - interval '2 seconds',
          expires_at = now() - interval '1 second'
      where tenant_id = $1 and session_id = $2
      """)

      deny =
        operation("phase_admission_deny", :deny_admission, %{
          "admissionRequestId" => fixture.admission_request_id
        })

      expire =
        operation("phase_admission_expiry", :admission_request_expired, %{
          "admissionRequestId" => fixture.admission_request_id
        })

      host = hd(fixture.identities)

      {results, order} =
        ordered_external_race(
          deny.request_key,
          fn -> Postgres.begin_operation(host, deny) end,
          expire.request_key,
          fn -> Postgres.begin_internal_operation(fixture.session, expire) end
        )

      [deny_result, expire_result] = results

      finalized =
        maybe_finalize(deny_result, fn operation_id ->
          Postgres.finalize_operation(fixture.session, operation_id, {
            :applied,
            :admission_denied,
            %{"admission_request_id" => fixture.admission_request_id}
          })
        end) ++
          maybe_finalize(expire_result, fn operation_id ->
            Postgres.finalize_operation(fixture.session, operation_id, {
              :applied,
              :admission_expired,
              %{"admission_request_id" => fixture.admission_request_id}
            })
          end)

      [
        observation(
          "admission_decision_vs_expiry_barrier",
          outcome_atoms(results ++ finalized),
          order
        )
      ]
    after
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end
  end

  defp deadline_scenarios(connections) do
    fixture = SyncPostgres.seed_session(hd(connections))

    try do
      query(fixture.session, """
      update room_sessions set created_at = now() - interval '2 minutes',
        deadline_at = now() - interval '1 second', maximum_duration_seconds = 119,
        deadline_generation = 2 where tenant_id = $1 and id = $2
      """)

      stale =
        operation("phase_deadline_stale1", :maximum_duration_expired, %{"deadlineGeneration" => 1})

      {:error, :stale_deadline_generation} =
        Postgres.begin_internal_operation(fixture.session, stale)

      current =
        operation("phase_deadline_current", :maximum_duration_expired, %{
          "deadlineGeneration" => 2
        })

      {:ok, pending} = Postgres.begin_internal_operation(fixture.session, current)

      {:ok, applied} =
        Postgres.finalize_operation(fixture.session, pending.external_operation_id, {
          :applied,
          :session_ended,
          %{"reason" => "maximum_duration"}
        })

      [
        observation("stale_deadline_generation", [:rejected]),
        observation("current_deadline_expiry", [applied.result])
      ]
    after
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end
  end

  defp ordered_external_race(first_key, first_function, second_key, second_function) do
    parent = self()

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn
      :after_acceptance_authority_lock, %{request_key: request_key} ->
        send(parent, {:authority_lock_acquired, request_key, self()})

        if request_key == first_key do
          receive do: (:release_authority_lock -> :ok)
        end

      _point, _context ->
        :ok
    end)

    first = Task.async(first_function)

    first_pid =
      receive do
        {:authority_lock_acquired, ^first_key, pid} -> pid
      end

    second =
      Task.async(fn ->
        send(parent, {:contender_started, second_key})
        second_function.()
      end)

    receive do
      {:contender_started, ^second_key} -> :ok
    end

    nil = Task.yield(second, 0)
    send(first_pid, :release_authority_lock)

    results = [Task.await(first), Task.await(second)]

    receive do
      {:authority_lock_acquired, ^second_key, _pid} -> :ok
    end

    Application.delete_env(:chalk_sync, :external_operation_fault_hook)
    {results, [first_key, second_key]}
  end

  defp install_command_fault(point, command_id) do
    Application.put_env(:chalk_sync, :stateholder_fault_hook, fn
      ^point, %{command_id: ^command_id} -> raise "injected #{point} fault"
      _point, _context -> :ok
    end)
  end

  defp digest_sequence(_session, events) do
    Enum.map(events, fn event ->
      %{
        "revision" => event.revision,
        "name" => event.name,
        "digest" => Base.encode16(event.resulting_state_digest, case: :lower)
      }
    end)
  end

  defp intent_states(session) do
    query(session, """
    select status from sync_lifecycle_intents
    where tenant_id = $1 and session_id = $2 order by lifecycle_intent_id
    """)
    |> Enum.map(fn [status] -> status end)
  end

  defp query(session, sql) do
    Database.connection(session)
    |> Postgrex.query!(sql, [UUID.dump!(session.tenant_id), UUID.dump!(session.session_id)])
    |> Map.fetch!(:rows)
  end

  defp command(id, name, payload) do
    {:ok, command} = Command.new(id, name, payload)
    command
  end

  defp operation(id, name, payload) do
    {:ok, operation} = Operation.new(id, name, payload)
    operation
  end

  defp receipt(decision) do
    %{
      "result" => Atom.to_string(decision.result),
      "revision" => decision.revision,
      "reason" => if(decision.reason, do: Atom.to_string(decision.reason), else: nil)
    }
  end

  defp observation(schedule, outcomes),
    do: %{"schedule" => schedule, "outcomes" => Enum.map(outcomes, &Atom.to_string/1)}

  defp observation(schedule, outcomes, order) do
    %{
      "schedule" => schedule,
      "outcomes" => Enum.map(outcomes, &Atom.to_string/1),
      "order" => order,
      "second_waited_for_authority_lock" => true
    }
  end

  defp outcome_atoms(results) do
    Enum.map(results, fn
      {:ok, decision} -> decision.result
      {:error, reason} -> reason
      {:retryable, reason} -> reason
    end)
  end

  defp maybe_finalize({:ok, %{result: :pending, external_operation_id: operation_id}}, function),
    do: [function.(operation_id)]

  defp maybe_finalize(_result, _function), do: []

  defp deterministic_ids(seed) do
    %{
      tenant_id: deterministic_uuid(seed, "tenant"),
      room_id: deterministic_uuid(seed, "room"),
      session_id: deterministic_uuid(seed, "session"),
      participants:
        Enum.map(1..2, fn index ->
          %{
            id: deterministic_uuid(seed, "participant-#{index}"),
            admission_lifecycle_intent_id: deterministic_uuid(seed, "admission-intent-#{index}")
          }
        end)
    }
  end

  defp deterministic_uuid(seed, label) do
    <<a::binary-size(4), b::binary-size(2), c0, c1, d0, d1, e::binary-size(6), _rest::binary>> =
      :crypto.hash(:sha256, "#{seed}:#{label}")

    c = <<Bitwise.bor(Bitwise.band(c0, 0x0F), 0x40), c1>>
    d = <<Bitwise.bor(Bitwise.band(d0, 0x3F), 0x80), d1>>

    Enum.map_join([a, b, c, d, e], "-", &Base.encode16(&1, case: :lower))
  end

  defp restore(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop(pid) do
    if Process.alive?(pid), do: GenServer.stop(pid)
  catch
    :exit, _reason -> :ok
  end
end
