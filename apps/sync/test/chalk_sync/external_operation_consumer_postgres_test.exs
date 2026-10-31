defmodule ChalkSync.ExternalOperationConsumerPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.RecordingPlaneTestAdapter
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url, 4)
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

  test "claims, confirms through MediaPlane, and finalizes exactly once", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_episode(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_pg_mute_01", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, external} =
             Enum.find(claimed, fn {_episode, candidate} ->
               candidate.external_operation_id == operation_id
             end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert [{:revoke_publication, ^operation_id, [^episode, _, :microphone]}] =
             MediaPlaneTestAdapter.calls(adapter)

    assert {:ok, %{status: :applied, attempt_count: 1}} =
             Postgres.read_operation(fixture.episode, operation_id)

    assert {:ok, remaining} = Postgres.claim_operations(64)

    refute Enum.any?(remaining, fn {_episode, candidate} ->
             candidate.external_operation_id == operation_id
           end)
  end

  test "provider confirmation survives loss before durable finalization", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_episode(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_lost_confirm1", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, external} =
             Enum.find(claimed, fn {_episode, candidate} ->
               candidate.external_operation_id == operation_id
             end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_provider_confirmation_before_finalize,
        do: raise("lost provider confirmation response")
    end)

    on_exit(fn -> Application.delete_env(:chalk_sync, :external_operation_fault_hook) end)

    assert_raise RuntimeError, "lost provider confirmation response", fn ->
      ExternalOperationConsumer.execute_operation(
        episode,
        external,
        {MediaPlaneTestAdapter, adapter},
        nil,
        &Postgres.finalize_operation/3
      )
    end

    assert {:ok, %{status: :pending}} = Postgres.read_operation(fixture.episode, operation_id)
    Application.delete_env(:chalk_sync, :external_operation_fault_hook)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied}} = Postgres.read_operation(fixture.episode, operation_id)

    assert [
             {:revoke_publication, ^operation_id, [^episode, _, :microphone]},
             {:revoke_publication, ^operation_id, [^episode, _, :microphone]}
           ] = MediaPlaneTestAdapter.calls(adapter)
  end

  test "an expired last claim is reclaimed and settles its publication fence", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_exhausted_mute_01", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(host, operation)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100}} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, reclaimed} = Postgres.claim_operations(64)

    assert {^episode, %{attempt_count: 100}} =
             Enum.find(reclaimed, fn {_, op} -> op.external_operation_id == id end)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, reclaimed_again} = Postgres.claim_operations(64)

    assert {^episode, %{attempt_count: 100} = external} =
             Enum.find(reclaimed_again, fn {_, op} -> op.external_operation_id == id end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(episode, id, {:confirmed, :provider})

    assert [["applied", "committed", 0]] =
             Postgrex.query!(
               connection,
               """
               select operation.status, receipt.outcome, count(fence.external_operation_id)
               from sync_external_operations operation
               join sync_command_receipts receipt using(external_operation_id)
               left join sync_publication_fences fence using(external_operation_id)
               where operation.external_operation_id=$1
               group by operation.status, receipt.outcome
               """,
               [UUID.dump!(id)]
             ).rows

    {:ok, later} =
      Operation.new("consumer_after_exhausted_mute", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: later_id}} = Postgres.begin_operation(host, later)
    assert {:ok, later_claims} = Postgres.claim_operations(64)

    assert {^episode, later_external} =
             Enum.find(later_claims, fn {_, op} -> op.external_operation_id == later_id end)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               later_external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, later_id)

    {:ok, end_episode} = Operation.new("consumer_after_exhausted_end", :end_episode, %{})
    assert {:ok, %{external_operation_id: end_id}} = Postgres.begin_operation(host, end_episode)
    assert {:ok, end_claims} = Postgres.claim_operations(64)

    assert {^episode, end_external} =
             Enum.find(end_claims, fn {_, op} -> op.external_operation_id == end_id end)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               end_external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )
  end

  test "an exhausted reclaim preserves a terminal provider outcome", %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_exhausted_terminal", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(host, operation)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100}} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, reclaimed} = Postgres.claim_operations(64)

    assert {^episode, external} =
             Enum.find(reclaimed, fn {_, op} -> op.external_operation_id == id end)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{revoke_publication: {:terminal_failure, :provider_rejected}}
      )

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed, last_error_code: :provider_rejected}} =
             Postgres.read_operation(episode, id)

    assert [{:revoke_publication, ^id, [^episode, _, :microphone]}] =
             MediaPlaneTestAdapter.calls(adapter)
  end

  test "two rolled back last-attempt finalizations reclaim without duplicate outbox rows", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.left"])
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_exhausted_rollback", :remove_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(host, operation)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("injected finalization rollback")
    end)

    on_exit(fn -> Application.delete_env(:chalk_sync, :external_operation_fault_hook) end)

    for _ <- 1..2 do
      assert {:ok, claimed} = Postgres.claim_operations(64)

      assert {episode, %{attempt_count: 100} = external} =
               Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

      assert :finalization_failure =
               ExternalOperationConsumer.execute_operation(
                 episode,
                 external,
                 {MediaPlaneTestAdapter, adapter},
                 nil,
                 &Postgres.finalize_operation/3
               )

      assert {:ok, %{status: :pending}} = Postgres.read_operation(episode, id)

      assert [["pending", 3, 0, 0]] =
               Postgrex.query!(
                 connection,
                 """
                 select receipt.outcome,
                   (select count(*) from sync_publication_fences where external_operation_id=$1),
                   (select count(*) from webhook_events where tenant_id=$2),
                   (select count(*) from webhook_deliveries where tenant_id=$2)
                 from sync_command_receipts receipt where receipt.external_operation_id=$1
                 """,
                 [UUID.dump!(id), UUID.dump!(episode.tenant_id)]
               ).rows

      Postgrex.query!(
        connection,
        "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
        [UUID.dump!(id)]
      )
    end

    Application.delete_env(:chalk_sync, :external_operation_fault_hook)
    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100} = external} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(episode, id, {:confirmed, :provider})

    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, id)

    assert [["committed", 1, 0, 1, 1]] =
             Postgrex.query!(
               connection,
               """
               select receipt.outcome,
                 (select count(*) from sync_command_receipts where external_operation_id=$1),
                 (select count(*) from sync_publication_fences where external_operation_id=$1),
                 (select count(*) from webhook_events where tenant_id=$2),
                 (select count(*) from webhook_deliveries where tenant_id=$2)
               from sync_command_receipts receipt where receipt.external_operation_id=$1
               """,
               [UUID.dump!(id), UUID.dump!(episode.tenant_id)]
             ).rows

    assert [
             {:remove_participant, ^id, _},
             {:remove_participant, ^id, _},
             {:remove_participant, ^id, _}
           ] = MediaPlaneTestAdapter.calls(adapter)
  end

  test "an ambiguous last attempt can be reclaimed after finalization failure", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_exhausted_pending", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(host, operation)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100} = external} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

    assert :finalization_failure =
             ExternalOperationConsumer.execute_operation(episode, external, nil, nil, fn _,
                                                                                         _,
                                                                                         _ ->
               {:error, :unavailable}
             end)

    assert {:ok, %{status: :pending}} = Postgres.read_operation(episode, id)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    claims =
      1..2
      |> Task.async_stream(fn _ -> Postgres.claim_operations(64) end, max_concurrency: 2)
      |> Enum.to_list()

    reclaimed =
      for {:ok, {:ok, ops}} <- claims,
          {^episode, op} <- ops,
          op.external_operation_id == id,
          do: op

    assert [%{attempt_count: 100} = retry] = reclaimed

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               episode,
               retry,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed, last_error_code: :retry_exhausted}} =
             Postgres.read_operation(episode, id)

    assert {:ok, %{result: :failed, delivery: :duplicate}} =
             Postgres.finalize_operation(episode, id, {:failed, :retry_exhausted})

    assert [["failed", "rejected", 0]] =
             Postgrex.query!(
               connection,
               """
               select operation.status, receipt.outcome, count(fence.external_operation_id)
               from sync_external_operations operation
               join sync_command_receipts receipt using(external_operation_id)
               left join sync_publication_fences fence using(external_operation_id)
               where operation.external_operation_id=$1
               group by operation.status, receipt.outcome
               """,
               [UUID.dump!(id)]
             ).rows
  end

  test "Episode end claims the active recording and requires both provider cleanups", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_episode(hd(connections), 1)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    host = hd(fixture.identities)
    recording_id = UUID.generate()

    {:ok, start_recording} =
      Operation.new("consumer_pg_record_start", :start_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: start_id}} =
             Postgres.begin_operation(host, start_recording)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, start_id, {:confirmed, :recording})

    {:ok, end_episode} = Operation.new("consumer_pg_end_0001", :end_episode, %{})

    assert {:ok, %{external_operation_id: end_id}} =
             Postgres.begin_operation(host, end_episode)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{recording_id: ^recording_id} = external} =
             Enum.find(claimed, fn {_episode, candidate} ->
               candidate.external_operation_id == end_id
             end)

    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()
    {:ok, recording_adapter} = RecordingPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, media_adapter},
               {RecordingPlaneTestAdapter, recording_adapter},
               &Postgres.finalize_operation/3
             )

    assert [{:end_episode, ^end_id, [^episode]}] = MediaPlaneTestAdapter.calls(media_adapter)

    assert [{:stop_recording, ^end_id, [^episode, ^recording_id]}] =
             RecordingPlaneTestAdapter.calls(recording_adapter)

    assert {:ok, %{status: :applied}} = Postgres.read_operation(fixture.episode, end_id)
  end

  test "an exhausted operation for a departed target settles instead of reclaiming forever", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_exhausted_departed_mute", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(host, operation)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    Postgrex.query!(
      connection,
      "update participants set status='left' where id=$1",
      [UUID.dump!(guest.participant_id)]
    )

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100} = external} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == id end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    ExternalOperationConsumer.execute_operation(
      episode,
      external,
      {MediaPlaneTestAdapter, adapter},
      nil,
      &Postgres.finalize_operation/3
    )

    assert {:ok, %{status: :failed, last_error_code: reason}} =
             Postgres.read_operation(episode, id)

    assert reason in [:participant_inactive, :stale_participant_generation]

    assert [["failed", "rejected", 0]] =
             Postgrex.query!(
               connection,
               """
               select operation.status, receipt.outcome, count(fence.external_operation_id)
               from sync_external_operations operation
               join sync_command_receipts receipt using(external_operation_id)
               left join sync_publication_fences fence using(external_operation_id)
               where operation.external_operation_id=$1
               group by operation.status, receipt.outcome
               """,
               [UUID.dump!(id)]
             ).rows

    assert {:ok, %{delivery: :duplicate}} =
             Postgres.finalize_operation(episode, id, {:confirmed, :provider})

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(id)]
    )

    assert {:ok, reclaimed} = Postgres.claim_operations(64)
    refute Enum.any?(reclaimed, fn {_, op} -> op.external_operation_id == id end)
    assert [{:revoke_publication, ^id, _}] = MediaPlaneTestAdapter.calls(adapter)
  end

  test "operation rows decode in a fresh VM without loading consumers" do
    code = ~S'''
    try do
      String.to_existing_atom("role_transition_source_stop")
      raise "operation atom unexpectedly loaded"
    rescue
      ArgumentError -> :ok
    end

    record = Module.concat(["ChalkSync", "Stateholder", "Postgres", "ExternalOperationRecord"])
    names = ~w(admit_participant deny_admission admission_request_expired mute_participant
      stop_participant_camera stop_participant_screen_share remove_participant start_recording
      stop_recording recording_capture_ready recording_capture_stopped recording_capture_failed
      participant_leave end_episode tenant_assign_roles tenant_set_deadline tenant_end_episode
      maximum_episode_duration_expired role_transition_cleanup role_transition_source_stop)
    for name <- names, status <- ~w(pending applied failed), source <- [nil, "microphone", "camera", "screen"] do
      row = [nil, nil, nil, <<0::128>>, nil, "key", <<>>, name, nil, nil, nil, nil,
             source, nil, nil, nil, nil, nil, nil, nil, nil, %{}, status, 0, nil, nil, nil]
      operation = apply(record, :from_row, [row])
      expected = if name == "maximum_episode_duration_expired", do: "maximum_duration_expired", else: name
      unless Atom.to_string(operation.name) == expected and Atom.to_string(operation.status) == status and
               (is_nil(source) or Atom.to_string(operation.source) == source), do: raise("incorrect decode")
    end
    row = [nil, nil, nil, <<0::128>>, nil, "key", <<>>, "not_an_operation", nil, nil, nil, nil,
           nil, nil, nil, nil, nil, nil, nil, nil, nil, %{}, "pending", 0, nil, nil, nil]
    try do
      apply(record, :from_row, [row])
      raise "unknown operation accepted"
    rescue
      KeyError -> :ok
    end
    '''

    beam_dir =
      :code.which(ChalkSync.Stateholder.Postgres.ExternalOperationRecord)
      |> to_string()
      |> Path.dirname()

    {output, status} =
      System.cmd("elixir", ["--erl", "+S 2:2", "-pa", beam_dir, "-e", code],
        stderr_to_stdout: true
      )

    assert status == 0, output
  end

  test "an exhausted role source stop for a departed target settles its role transition", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities

    {:ok, promote} =
      Command.new("consumer_obsolete_role_up", :assign_roles, %{
        "participantId" => guest.participant_id,
        "role" => "collaborator"
      })

    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, promote, [])

    {:ok, demote} =
      Command.new("consumer_obsolete_role_down", :assign_roles, %{
        "participantId" => guest.participant_id,
        "role" => "observer"
      })

    publications = [%{participant_id: guest.participant_id, source: :microphone, enabled: true}]
    assert {:ok, _decision} = Postgres.begin_role_transition(host, demote, publications)

    [[child_id, parent_id]] =
      Postgrex.query!(
        connection,
        """
        select external_operation_id, parent_external_operation_id
        from sync_external_operations
        where operation_name = 'role_transition_source_stop' and target_participant_id = $1
        """,
        [UUID.dump!(guest.participant_id)]
      ).rows

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [child_id]
    )

    Postgrex.query!(connection, "update participants set status='left' where id=$1", [
      UUID.dump!(guest.participant_id)
    ])

    child = UUID.load!(child_id)
    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {episode, %{attempt_count: 100} = external} =
             Enum.find(claimed, fn {_, op} -> op.external_operation_id == child end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    ExternalOperationConsumer.execute_operation(
      episode,
      external,
      {MediaPlaneTestAdapter, adapter},
      nil,
      &Postgres.finalize_operation/3
    )

    assert [["failed", "failed", "rejected"]] =
             Postgrex.query!(
               connection,
               """
               select child.status, parent.status, receipt.outcome
               from sync_external_operations child
               join sync_external_operations parent
                 on parent.external_operation_id = child.parent_external_operation_id
               join sync_command_receipts receipt
                 on receipt.external_operation_id = parent.external_operation_id
               where child.external_operation_id = $1 and parent.external_operation_id = $2
               """,
               [child_id, parent_id]
             ).rows
  end

  test "migration re-arms exhausted cleanup and its command receipt without replacing identity",
       %{connections: connections} do
    connection = hd(connections)

    for mode <- [:pending, :exhausted, :unrelated_failure] do
      fixture = SyncPostgres.seed_episode(connection, 1)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      host = hd(fixture.identities)
      {:ok, operation} = Operation.new("consumer_pg_stale_end", :end_episode, %{})
      assert {:ok, %{external_operation_id: end_id}} = Postgres.begin_operation(host, operation)

      Postgrex.query!(connection, "update episodes set status = 'ending' where id = $1", [
        UUID.dump!(fixture.episode.episode_id)
      ])

      Postgrex.query!(
        connection,
        "update sync_external_operations set attempt_count = 100, next_attempt_at = now() where external_operation_id = $1",
        [UUID.dump!(end_id)]
      )

      if mode != :pending do
        reason = if mode == :exhausted, do: :retry_exhausted, else: :provider_rejected
        assert {:ok, _} = Postgres.finalize_operation(fixture.episode, end_id, {:failed, reason})
      end

      assert {:ok, before} = Postgres.read_operation(fixture.episode, end_id)

      migration =
        File.read!("../api/db/migrations/20260930150000_provider_teardown_failure_receipts.sql")

      [_, recovery] = String.split(migration, "-- Re-arm", parts: 2)
      [recovery, _] = String.split(recovery, "-- +goose Down", parts: 2)
      Postgrex.query!(connection, "-- Re-arm" <> recovery, [])

      %{rows: [[product_status]]} =
        Postgrex.query!(connection, "select status from episodes where id = $1", [
          UUID.dump!(fixture.episode.episode_id)
        ])

      assert product_status == if(mode == :unrelated_failure, do: "active", else: "ending")
      assert {:ok, recovered} = Postgres.read_operation(fixture.episode, end_id)
      assert recovered.external_operation_id == before.external_operation_id
      assert recovered.request_fingerprint == before.request_fingerprint

      if mode == :unrelated_failure do
        assert recovered.status == :failed
        assert recovered.last_error_code == :provider_rejected
      else
        assert recovered.status == :pending
        assert recovered.attempt_count == 0
        assert {:ok, claimed} = Postgres.claim_operations(64)

        assert {episode, external} =
                 Enum.find(claimed, fn {_, candidate} ->
                   candidate.external_operation_id == end_id
                 end)

        {:ok, adapter} = MediaPlaneTestAdapter.start_link()

        assert :confirmed =
                 ExternalOperationConsumer.execute_operation(
                   episode,
                   external,
                   {MediaPlaneTestAdapter, adapter},
                   nil,
                   &Postgres.finalize_operation/3
                 )

        assert {:ok, %{status: :applied}} = Postgres.read_operation(fixture.episode, end_id)
      end
    end
  end

  test "migration leaves reused Episodes and their failed end receipts untouched",
       %{connections: connections} do
    connection = hd(connections)

    for {status, activity} <- [
          {:failed, :join},
          {:failed, :command},
          {:failed, :chat_message},
          {:pending, :join},
          {:pending, :command}
        ] do
      fixture = SyncPostgres.seed_episode(connection, 1)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      host = hd(fixture.identities)
      {:ok, operation} = Operation.new("consumer_pg_reused_end", :end_episode, %{})
      assert {:ok, %{external_operation_id: end_id}} = Postgres.begin_operation(host, operation)

      Postgrex.query!(
        connection,
        "update sync_external_operations set attempt_count = 100 where external_operation_id = $1",
        [UUID.dump!(end_id)]
      )

      if status == :failed do
        assert {:ok, _} =
                 Postgres.finalize_operation(fixture.episode, end_id, {:failed, :retry_exhausted})
      end

      case activity do
        :join ->
          Postgrex.query!(connection, "update participants set joined_at = now() where id = $1", [
            UUID.dump!(host.participant_id)
          ])

        :command ->
          {:ok, command} =
            Command.new("consumer_pg_reused_hand", :set_hand_raised, %{"raised" => true})

          assert {:ok, _} = Postgres.decide_command(host, command)

        :chat_message ->
          assert {:ok, _} =
                   ChalkSync.Chat.Repository.Postgres.append(host, %{
                     client_message_id: "consumer_pg_reused_chat",
                     text: "Still using this Episode",
                     attachment_ids: []
                   })
      end

      %{rows: before_episode} =
        Postgrex.query!(connection, "select status, updated_at from episodes where id = $1", [
          UUID.dump!(fixture.episode.episode_id)
        ])

      %{rows: before_receipt} =
        Postgrex.query!(
          connection,
          "select outcome, rejection_reason, completed_at from sync_command_receipts where external_operation_id = $1",
          [UUID.dump!(end_id)]
        )

      assert {:ok, before_operation} = Postgres.read_operation(fixture.episode, end_id)

      migration =
        File.read!("../api/db/migrations/20260930150000_provider_teardown_failure_receipts.sql")

      [_, recovery] = String.split(migration, "-- Re-arm", parts: 2)
      [recovery, _] = String.split(recovery, "-- +goose Down", parts: 2)
      Postgrex.query!(connection, "-- Re-arm" <> recovery, [])

      assert {:ok, ^before_operation} = Postgres.read_operation(fixture.episode, end_id)

      assert %{rows: ^before_episode} =
               Postgrex.query!(
                 connection,
                 "select status, updated_at from episodes where id = $1",
                 [
                   UUID.dump!(fixture.episode.episode_id)
                 ]
               )

      assert %{rows: ^before_receipt} =
               Postgrex.query!(
                 connection,
                 "select outcome, rejection_reason, completed_at from sync_command_receipts where external_operation_id = $1",
                 [UUID.dump!(end_id)]
               )
    end
  end

  defp stop_connection(connection), do: TestProcess.stop(connection)
end
