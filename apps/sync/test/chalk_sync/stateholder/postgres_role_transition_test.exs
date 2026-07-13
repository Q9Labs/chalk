defmodule ChalkSync.Stateholder.PostgresRoleTransitionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @role_capabilities %{
    "host" => [
      "publishAudio",
      "publishVideo",
      "publishScreen",
      "subscribe",
      "promoteDemote",
      "transferHost",
      "muteOthers",
      "removeParticipant",
      "endMeeting",
      "manageAdmission",
      "manageRecording"
    ],
    "cohost" => ["publishAudio", "publishVideo", "subscribe"],
    "participant" => ["subscribe"]
  }

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
    fixture =
      SyncPostgres.seed_session(hd(connections), 2, %{role_capabilities: @role_capabilities})

    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    {:ok, fixture: fixture, connection: hd(connections)}
  end

  test "commits immediately when the transition loses no exercised capability", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities
    command = role_command("role_promote_safe1", guest.participant_session_id, "cohost")

    assert {:ok, %{result: :committed, revision: 3}} =
             Postgres.begin_role_transition(host, command, [])

    assert {:ok, %{result: :committed, delivery: :duplicate, revision: 3}} =
             Postgres.begin_role_transition(host, command, [])
  end

  test "reduces authority before cleanup and deduplicates the pending parent receipt", %{
    fixture: fixture,
    connection: connection
  } do
    [host, guest] = promote_guest(fixture)
    command = role_command("role_demote_media1", guest.participant_session_id, "participant")
    observed = [publication(guest, :microphone), publication(guest, :camera)]

    assert {:ok, %{result: :pending, revision: 4} = pending} =
             Postgres.begin_role_transition(host, command, observed)

    assert {:ok, duplicate} = Postgres.begin_role_transition(host, command, observed)
    assert duplicate.result == :pending
    assert duplicate.delivery == :duplicate
    assert duplicate.external_operation_id == pending.external_operation_id
    assert duplicate.event_id == pending.event_id

    assert [["participant"]] =
             query(connection, "select role from participants where id = $1", [
               UUID.dump!(guest.participant_session_id)
             ])

    assert [["camera"], ["microphone"]] =
             query(
               connection,
               "select source from sync_external_operations where parent_external_operation_id = $1 order by source",
               [UUID.dump!(pending.external_operation_id)]
             )

    assert [[2]] =
             query(
               connection,
               "select count(*) from sync_publication_fences where external_operation_id = $1",
               [UUID.dump!(pending.external_operation_id)]
             )

    assert {:error, :capability_denied} =
             Postgres.reserve_publication_grant(guest, "later_camera_grant1", :camera)
  end

  test "an accepted grant blocks its cleanup child until completion, then all children aggregate",
       %{
         fixture: fixture,
         connection: connection
       } do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "accepted_grant_001", :microphone)

    command = role_command("role_grant_race01", guest.participant_session_id, "participant")

    assert {:ok, %{result: :pending} = parent} =
             Postgres.begin_role_transition(
               host,
               command,
               [publication(guest, :camera)]
             )

    assert {:ok, claimed_before} = Postgres.claim_operations(64)

    refute Enum.any?(
             claimed_before,
             &child_source?(&1, parent.external_operation_id, :microphone)
           )

    camera = child!(claimed_before, parent.external_operation_id, :camera)

    assert {:ok, %{status: :confirmed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               :confirmed
             )

    assert {:ok, claimed} = Postgres.claim_operations(64)
    microphone = child!(claimed, parent.external_operation_id, :microphone)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               microphone.external_operation_id,
               {:confirmed, :provider}
             )

    assert [["pending"]] = receipt_outcome(connection, parent.external_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               camera.external_operation_id,
               {:confirmed, :provider}
             )

    assert [["committed"]] = receipt_outcome(connection, parent.external_operation_id)
    assert [[0]] = fence_count(connection, parent.external_operation_id)
  end

  test "a completed grant reservation can be replaced by a later enable", %{fixture: fixture} do
    [_host, guest] = promote_guest(fixture)

    assert {:ok, first} =
             Postgres.reserve_publication_grant(guest, "enable_then_disable1", :microphone)

    assert {:ok, %{status: :confirmed, result: :authorized}} =
             Postgres.complete_publication_grant(
               fixture.session,
               first.reservation_id,
               :confirmed
             )

    assert {:ok, second} =
             Postgres.reserve_publication_grant(guest, "enable_after_disable1", :microphone)

    assert second.reservation_id != first.reservation_id
    assert second.status == :pending

    assert {:ok, %{reservation_id: first_id, status: :confirmed}} =
             Postgres.complete_publication_grant(
               fixture.session,
               first.reservation_id,
               :confirmed
             )

    assert first_id == first.reservation_id
  end

  test "an accepted grant also blocks an earlier moderation stop from overtaking it", %{
    fixture: fixture
  } do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "grant_before_mute01", :microphone)

    {:ok, mute} =
      Operation.new("mute_after_grant01", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, mute)
    assert {:ok, claimed_before} = Postgres.claim_operations(64)

    refute Enum.any?(claimed_before, fn {_session, operation} ->
             operation.external_operation_id == pending.external_operation_id
           end)

    assert {:ok, %{status: :confirmed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               :confirmed
             )

    assert {:ok, claimed_after} = Postgres.claim_operations(64)

    assert Enum.any?(claimed_after, fn {_session, operation} ->
             operation.external_operation_id == pending.external_operation_id
           end)
  end

  test "an accepted grant blocks participant removal until grant completion", %{fixture: fixture} do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "grant_before_remove1", :camera)

    {:ok, remove} =
      Operation.new("remove_after_grant1", :remove_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, remove)
    assert {:ok, claimed_before} = Postgres.claim_operations(64)
    refute claimed?(claimed_before, pending.external_operation_id)

    assert {:ok, %{status: :confirmed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               :confirmed
             )

    assert {:ok, claimed_after} = Postgres.claim_operations(64)
    assert claimed?(claimed_after, pending.external_operation_id)
  end

  test "an accepted grant blocks Session end until grant completion", %{fixture: fixture} do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "grant_before_end_01", :microphone)

    {:ok, ending} = Operation.new("end_after_grant_01", :end_session, %{})
    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, ending)

    assert {:error, :session_ended} =
             Postgres.reserve_publication_grant(guest, "grant_after_end_0001", :camera)

    assert {:ok, claimed_before} = Postgres.claim_operations(64)
    refute claimed?(claimed_before, pending.external_operation_id)

    assert {:ok, %{status: :confirmed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               :confirmed
             )

    assert {:ok, claimed_after} = Postgres.claim_operations(64)
    assert claimed?(claimed_after, pending.external_operation_id)
  end

  test "an ambiguous grant blocks Session end only through its bounded expiry", %{
    fixture: fixture,
    connection: connection
  } do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "grant_before_end_02", :camera)

    assert {:ok, %{status: :ambiguous}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               :uncertain
             )

    {:ok, ending} = Operation.new("end_after_grant_02", :end_session, %{})
    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, ending)
    assert {:ok, claimed_before} = Postgres.claim_operations(64)
    refute claimed?(claimed_before, pending.external_operation_id)

    query(
      connection,
      "update sync_publication_grant_reservations set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where reservation_id = $1",
      [UUID.dump!(reservation.reservation_id)]
    )

    assert {:ok, claimed_after} = Postgres.claim_operations(64)
    assert claimed?(claimed_after, pending.external_operation_id)
  end

  test "confirmation constructs an admission fact from the locked reservation", %{
    fixture: fixture,
    connection: connection
  } do
    [host, _guest] = fixture.identities
    fixture = SyncPostgres.seed_admission_request(connection, fixture)

    {:ok, admit} =
      Operation.new("confirm_admission1", :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, admit)

    assert {:ok, %{result: :applied, event_id: event_id}} =
             Postgres.finalize_operation(
               fixture.session,
               pending.external_operation_id,
               {:confirmed, :local}
             )

    assert [["participant_joined"]] =
             query(connection, "select event_name from sync_control_events where event_id = $1", [
               UUID.dump!(event_id)
             ])
  end

  test "a confirmation from the wrong executor class cannot finalize an operation", %{
    fixture: fixture
  } do
    [host, guest] = fixture.identities

    {:ok, mute} =
      Operation.new("wrong_executor_001", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{result: :pending} = pending} = Postgres.begin_operation(host, mute)

    assert {:error, :invalid_operation_outcome} =
             Postgres.finalize_operation(
               fixture.session,
               pending.external_operation_id,
               {:confirmed, :local}
             )

    assert {:ok, %{status: :pending}} =
             Postgres.read_operation(fixture.session, pending.external_operation_id)
  end

  test "Session end acceptance retains the active Recording ID across duplicate reads", %{
    fixture: fixture
  } do
    [host, _guest] = fixture.identities
    recording_id = UUID.generate()

    {:ok, start} =
      Operation.new("record_before_end_1", :start_recording, %{"recordingId" => recording_id})

    assert {:ok, %{result: :pending}} = Postgres.begin_operation(host, start)

    {:ok, ending} = Operation.new("end_with_recording", :end_session, %{})
    assert {:ok, %{result: :pending} = accepted} = Postgres.begin_operation(host, ending)

    assert {:ok, %{result: :pending, delivery: :duplicate}} =
             Postgres.begin_operation(host, ending)

    assert {:ok, operation} =
             Postgres.read_operation(fixture.session, accepted.external_operation_id)

    assert operation.recording_id == recording_id
  end

  test "Session end acceptance retains nil when no Recording is active", %{fixture: fixture} do
    [host, _guest] = fixture.identities
    {:ok, ending} = Operation.new("end_without_record1", :end_session, %{})
    assert {:ok, %{result: :pending} = accepted} = Postgres.begin_operation(host, ending)

    assert {:ok, operation} =
             Postgres.read_operation(fixture.session, accepted.external_operation_id)

    assert operation.recording_id == nil
  end

  test "a terminal grant failure satisfies its source child without a provider stop", %{
    fixture: fixture,
    connection: connection
  } do
    [host, guest] = promote_guest(fixture)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(guest, "failed_grant_0001", :microphone)

    command = role_command("role_failed_grant1", guest.participant_session_id, "participant")
    assert {:ok, %{result: :pending} = parent} = Postgres.begin_role_transition(host, command, [])

    assert {:ok, %{status: :failed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               fixture.session,
               reservation.reservation_id,
               {:terminal_failure, :provider_denied}
             )

    assert [["committed"]] = receipt_outcome(connection, parent.external_operation_id)
    assert {:ok, []} = Postgres.claim_operations(64)
  end

  test "terminal cleanup failure preserves reduced authority, event linkage, and fences", %{
    fixture: fixture,
    connection: connection
  } do
    [host, guest] = promote_guest(fixture)
    command = role_command("role_cleanup_fail1", guest.participant_session_id, "participant")

    assert {:ok, %{result: :pending} = parent} =
             Postgres.begin_role_transition(host, command, [publication(guest, :camera)])

    assert {:ok, claimed} = Postgres.claim_operations(64)
    camera = child!(claimed, parent.external_operation_id, :camera)

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(
               fixture.session,
               camera.external_operation_id,
               {:failed, :provider_denied}
             )

    assert [["participant"]] =
             query(connection, "select role from participants where id = $1", [
               UUID.dump!(guest.participant_session_id)
             ])

    assert [["rejected", "external_operation_failed", event_id, 4]] =
             query(
               connection,
               "select outcome, rejection_reason, event_id, resulting_revision from sync_command_receipts where external_operation_id = $1",
               [UUID.dump!(parent.external_operation_id)]
             )

    assert is_binary(event_id)
    assert [[1]] = fence_count(connection, parent.external_operation_id)

    assert [["failed", true]] =
             query(
               connection,
               "select status, fence_active from sync_external_operations where external_operation_id = $1",
               [UUID.dump!(parent.external_operation_id)]
             )
  end

  test "host transfer fences and cleans the old host's lost source", %{fixture: fixture} do
    [host, guest] = fixture.identities
    command = transfer_command("host_transfer_media", guest.participant_session_id)

    assert {:ok, %{result: :pending} = parent} =
             Postgres.begin_role_transition(host, command, [publication(host, :screen)])

    assert {:ok, recovery} = Postgres.recover_session(fixture.session, nil)
    assert recovery.snapshot["host_participant_session_id"] == guest.participant_session_id

    assert {:ok, claimed} = Postgres.claim_operations(64)
    child = child!(claimed, parent.external_operation_id, :screen)
    assert child.target_participant_session_id == host.participant_session_id
  end

  defp promote_guest(fixture) do
    [host, guest] = fixture.identities
    command = role_command("promote_for_cleanup", guest.participant_session_id, "cohost")
    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, command, [])
    [host, guest]
  end

  defp role_command(id, participant_id, role) do
    {:ok, command} =
      Command.new(id, :set_participant_role, %{
        "participantSessionId" => participant_id,
        "role" => role
      })

    command
  end

  defp transfer_command(id, participant_id) do
    {:ok, command} =
      Command.new(id, :transfer_host, %{"participantSessionId" => participant_id})

    command
  end

  defp publication(identity, source) do
    %{
      participant_session_id: identity.participant_session_id,
      source: source,
      enabled: true,
      publication_id: nil
    }
  end

  defp child!(claimed, parent_id, source) do
    {_session, child} =
      Enum.find(claimed, fn {_session, operation} ->
        operation.parent_external_operation_id == parent_id and operation.source == source
      end)

    child
  end

  defp child_source?({_session, operation}, parent_id, source),
    do: operation.parent_external_operation_id == parent_id and operation.source == source

  defp claimed?(claimed, operation_id),
    do:
      Enum.any?(claimed, fn {_session, operation} ->
        operation.external_operation_id == operation_id
      end)

  defp receipt_outcome(connection, parent_id) do
    query(
      connection,
      "select outcome from sync_command_receipts where external_operation_id = $1",
      [UUID.dump!(parent_id)]
    )
  end

  defp fence_count(connection, parent_id) do
    query(
      connection,
      "select count(*) from sync_publication_fences where external_operation_id = $1",
      [UUID.dump!(parent_id)]
    )
  end

  defp query(connection, sql, params), do: Postgrex.query!(connection, sql, params).rows

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
