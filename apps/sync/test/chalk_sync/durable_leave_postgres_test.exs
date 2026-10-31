defmodule ChalkSync.DurableLeavePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  defmodule DelayedProvider do
    def remove_participant(owner, operation_id, _episode, _participant_id) do
      send(owner, {:cleanup_started, operation_id, self()})

      receive do
        :release -> :satisfied
      end
    end
  end

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "a caller crash after commit leaves replayable confirmation and claimable cleanup", %{
    connection: connection,
    fixture: fixture
  } do
    owner = self()
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_crash_leave_0001", :participant_leave, %{})

    {pid, monitor} =
      spawn_monitor(fn ->
        send(owner, {:committed, Postgres.begin_operation(identity, leave)})
        exit(:simulated_crash)
      end)

    assert_receive {:committed, {:ok, %{result: :applied, external_operation_id: id}}}, 5_000
    assert_receive {:DOWN, ^monitor, :process, ^pid, :simulated_crash}

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)

    assert {:error, :participant_inactive} =
             Postgres.participant_authority(
               fixture.episode,
               identity.participant_id,
               identity.participant_generation
             )

    assert {:error, :participant_inactive} =
             Postgres.reserve_publication_grant(identity, "departed_publication_001", :camera)

    assert {:error, _reason} = Postgres.confirm_admission(identity)
    cleanup = claim_cleanup(id)
    assert cleanup.target_participant_generation == identity.participant_generation
    assert cleanup.target_participant_id == identity.participant_id
    assert :confirmed = execute(fixture.episode, cleanup, nil)

    assert {:ok, %{status: :applied}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)

    assert [[1]] = cleanup_count(connection, id)
  end

  test "Leave and its webhook are committed while a delayed cleanup provider is blocked", %{
    connection: connection,
    fixture: fixture
  } do
    SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.left"])
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_delayed_leave_01", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)
    owner = self()
    task = Task.async(fn -> execute(fixture.episode, cleanup, {DelayedProvider, owner}) end)
    assert_receive {:cleanup_started, _, provider}, 5_000
    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [[1, true]] =
             Postgrex.query!(
               connection,
               """
               select count(*), bool_and(outbox.occurred_at=date_trunc('milliseconds',p.left_at))
               from webhook_events outbox join participants p on p.id=$1
               where outbox.tenant_id=p.tenant_id and outbox.event_name='participant.left'
               """,
               [UUID.dump!(identity.participant_id)]
             ).rows

    send(provider, :release)
    assert :confirmed = Task.await(task)
    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
  end

  test "cleanup exhaustion is retained without rejecting Leave or changing its timestamp", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_exhaust_leave_01", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)

    assert :pending =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               cleanup,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    cleanup = claim_cleanup(id)
    assert cleanup.attempt_count == 100

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               cleanup,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed, last_error_code: :retry_exhausted}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
    assert {:ok, remaining} = Postgres.claim_operations(64)

    refute Enum.any?(remaining, fn {_, operation} ->
             operation.external_operation_id == cleanup.external_operation_id
           end)
  end

  test "a rejoin is admitted while old cleanup is pending and survives its completion", %{
    connection: connection,
    fixture: fixture
  } do
    fixture = SyncPostgres.seed_admission_request(connection, fixture)
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_rejoin_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)

    {:ok, admission} =
      Operation.new("durable_rejoin_admit_001", :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: admission_id}} =
             Postgres.begin_operation(hd(fixture.identities), admission)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, admission_id, {:confirmed, :local})

    assert :confirmed = execute(fixture.episode, cleanup, nil)

    assert [["active"]] =
             Postgrex.query!(connection, "select status from participants where id=$1", [
               UUID.dump!(fixture.admission_participant_id)
             ]).rows

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
  end

  test "a crash on the last cleanup claim can still settle exhaustion", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_last_claim_0001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(identity, leave)
    cleanup = claim_cleanup(id)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    assert %{attempt_count: 100} = claim_cleanup(id)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    reclaimed = claim_cleanup(id)
    assert reclaimed.attempt_count == 100

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               reclaimed,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)
  end

  test "departure and cleanup roll back together before commit", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_atomic_leave_001", :participant_leave, %{})

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("transaction interrupted")
    end)

    on_exit(fn -> Application.delete_env(:chalk_sync, :external_operation_fault_hook) end)

    assert {:retryable, :decision_unavailable} = Postgres.begin_operation(identity, leave)

    assert [["active"]] =
             Postgrex.query!(connection, "select status from participants where id=$1", [
               UUID.dump!(identity.participant_id)
             ]).rows

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_external_operations where tenant_id=$1",
               [UUID.dump!(fixture.episode.tenant_id)]
             ).rows
  end

  defp claim_cleanup(id) do
    assert {:ok, operations} = Postgres.claim_operations(64)

    {_, cleanup} =
      Enum.find(operations, fn {_, operation} ->
        operation.name == :remove_participant and
          operation.payload["departureOperationId"] == id
      end)

    cleanup
  end

  defp execute(episode, cleanup, nil) do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    execute(episode, cleanup, {MediaPlaneTestAdapter, adapter})
  end

  defp execute(episode, cleanup, adapter),
    do:
      ExternalOperationConsumer.execute_operation(
        episode,
        cleanup,
        adapter,
        nil,
        &Postgres.finalize_operation/3
      )

  defp departure_rows(connection, participant_id, id) do
    Postgrex.query!(
      connection,
      "select p.status,p.left_at=operation.created_at from participants p join sync_external_operations operation on operation.external_operation_id=$2 where p.id=$1",
      [UUID.dump!(participant_id), UUID.dump!(id)]
    ).rows
  end

  defp cleanup_count(connection, id) do
    Postgrex.query!(
      connection,
      "select count(*) from sync_external_operations where payload->>'departureOperationId'=$1",
      [id]
    ).rows
  end
end
