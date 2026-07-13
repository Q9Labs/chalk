defmodule ChalkSync.ExternalOperationConsumerPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.RecordingPlaneTestAdapter
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
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_pg_mute_01", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {session, external} =
             Enum.find(claimed, fn {_session, candidate} ->
               candidate.external_operation_id == operation_id
             end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               session,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert [{:revoke_publication, ^operation_id, [^session, _, :microphone]}] =
             MediaPlaneTestAdapter.calls(adapter)

    assert {:ok, %{status: :applied, attempt_count: 1}} =
             Postgres.read_operation(fixture.session, operation_id)

    assert {:ok, remaining} = Postgres.claim_operations(64)

    refute Enum.any?(remaining, fn {_session, candidate} ->
             candidate.external_operation_id == operation_id
           end)
  end

  test "provider confirmation survives loss before durable finalization", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("consumer_lost_confirm1", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {session, external} =
             Enum.find(claimed, fn {_session, candidate} ->
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
        session,
        external,
        {MediaPlaneTestAdapter, adapter},
        nil,
        &Postgres.finalize_operation/3
      )
    end

    assert {:ok, %{status: :pending}} = Postgres.read_operation(fixture.session, operation_id)
    Application.delete_env(:chalk_sync, :external_operation_fault_hook)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               session,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied}} = Postgres.read_operation(fixture.session, operation_id)

    assert [
             {:revoke_publication, ^operation_id, [^session, _, :microphone]},
             {:revoke_publication, ^operation_id, [^session, _, :microphone]}
           ] = MediaPlaneTestAdapter.calls(adapter)
  end

  test "Session end claims the active recording and requires both provider cleanups", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 1)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    host = hd(fixture.identities)
    recording_id = UUID.generate()

    {:ok, start_recording} =
      Operation.new("consumer_pg_record_start", :start_recording, %{
        "recordingId" => recording_id
      })

    assert {:ok, %{external_operation_id: start_id}} =
             Postgres.begin_operation(host, start_recording)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.session, start_id, {:confirmed, :recording})

    {:ok, end_session} = Operation.new("consumer_pg_end_0001", :end_session, %{})

    assert {:ok, %{external_operation_id: end_id}} =
             Postgres.begin_operation(host, end_session)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {session, %{recording_id: ^recording_id} = external} =
             Enum.find(claimed, fn {_session, candidate} ->
               candidate.external_operation_id == end_id
             end)

    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()
    {:ok, recording_adapter} = RecordingPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               session,
               external,
               {MediaPlaneTestAdapter, media_adapter},
               {RecordingPlaneTestAdapter, recording_adapter},
               &Postgres.finalize_operation/3
             )

    assert [{:end_session, ^end_id, [^session]}] = MediaPlaneTestAdapter.calls(media_adapter)

    assert [{:stop_recording, ^end_id, [^session, ^recording_id]}] =
             RecordingPlaneTestAdapter.calls(recording_adapter)

    assert {:ok, %{status: :applied}} = Postgres.read_operation(fixture.session, end_id)
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
