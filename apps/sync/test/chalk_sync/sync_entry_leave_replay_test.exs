defmodule ChalkSync.SyncEntryLeaveReplayTest do
  @moduledoc """
  Replays the central traces of tools/formal/sync-entry-leave/SyncEntryLeave.tla
  against the real join-seat transactions:

    * LeftOnlyByNewestEntry    a Leave driven by an older confirmed entry is
                               refused; only the newest entry owns the Leave.
    * AdmissionWaitsForClaimedLeave  once a Leave operation is claimed, no new
                               entry is issued until it settles.

  The rolling-entry suite covers the same rules across an old-writer
  enforcement cutover; this file pins them to the model without that
  machinery.
  """
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 2)
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
    Postgrex.query!(
      connection,
      "update sync_entry_rollout set enforced=false, enforced_at=null, release_id=null",
      []
    )

    fixture = SyncPostgres.seed_pending_join(connection)

    Postgrex.query!(connection, "select enforce_sync_entry_ownership('replay-test')", [])

    on_exit(fn ->
      SyncPostgres.cleanup(connection, fixture.episode)

      Postgrex.query!(
        connection,
        "update sync_entry_rollout set enforced=true, enforced_at=now(), release_id='replay-test'",
        []
      )
    end)

    {:ok, fixture: fixture}
  end

  test "only the newest confirmed entry may drive the Leave", %{
    connection: connection,
    fixture: fixture
  } do
    {:ok, first} = Postgres.admit_entry(fixture.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(first)
    {:ok, second} = Postgres.admit_entry(fixture.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(second)
    assert second.entry_generation == first.entry_generation + 1

    stale = %{fixture.identity | entry_generation: first.entry_generation}
    newest = %{fixture.identity | entry_generation: second.entry_generation}

    assert {:error, :participant_inactive} =
             JoinSeats.validate_leave(connection, stale, %{name: :participant_leave})

    assert :ok = JoinSeats.validate_leave(connection, newest, %{name: :participant_leave})
  end

  test "no new entry is issued while a claimed Leave is pending", %{
    connection: connection,
    fixture: fixture
  } do
    {:ok, admitted} = Postgres.admit_entry(fixture.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(admitted)
    episode = fixture.episode
    operation_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, target_participant_id,
        target_participant_generation, payload, attempt_count,
        producing_trace_id, producing_span_id, control_revision
      ) values (
        $1, $2, $3, $4, 'replay-leave-00001', decode(repeat('00', 32), 'hex'),
        'participant_leave', $5, $6, $7, 1,
        '11111111111111111111111111111111', '2222222222222222',
        nextval('sync_source_control_revisions')
      )
      """,
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(operation_id),
        UUID.dump!(fixture.identity.participant_id),
        fixture.identity.participant_generation,
        %{"entryGeneration" => admitted.entry_generation}
      ]
    )

    assert {:retryable, :admission_pending} =
             Postgres.admit_entry(fixture.identity, :legacy)

    Postgrex.query!(
      connection,
      "update sync_external_operations set status='applied', completed_at=now() where external_operation_id=$1",
      [UUID.dump!(operation_id)]
    )

    assert {:ok, _} = Postgres.admit_entry(fixture.identity, :legacy)
  end
end
