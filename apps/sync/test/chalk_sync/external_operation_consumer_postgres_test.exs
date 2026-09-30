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

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
