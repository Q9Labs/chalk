defmodule ChalkSync.ExternalOperationClaimPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
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
    fixture = SyncPostgres.seed_episode(connection, 2, %{}, %{participants: [%{}, %{}]})
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "a maximum-duration end waits for a pending publication grant", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [_host, speaker] = fixture.identities

    {:ok, operation} = due_maximum_duration(connection, episode, "claim_max_duration_0001")

    assert {:ok, %{result: :pending, external_operation_id: operation_id}} =
             Postgres.begin_internal_operation(episode, operation)

    reserve_publication_grant(connection, episode, speaker)
    make_claimable(connection, operation_id)

    refute operation_id in claimed_ids()

    Postgrex.query!(
      connection,
      "update sync_publication_grant_reservations set status='failed',failure_code='test',completed_at=now() where episode_id=$1",
      [UUID.dump!(episode.episode_id)]
    )

    assert operation_id in claimed_ids()
  end

  defp claimed_ids do
    {:ok, operations} = Postgres.claim_operations(64)
    Enum.map(operations, fn {_episode, operation} -> operation.external_operation_id end)
  end

  defp due_maximum_duration(connection, episode, request_key) do
    %{rows: [[generation]]} =
      Postgrex.query!(
        connection,
        """
        update episodes
        set deadline_at = now() - interval '1 second', deadline_generation = deadline_generation + 1
        where id = $1
        returning deadline_generation
        """,
        [UUID.dump!(episode.episode_id)]
      )

    Operation.new(request_key, :maximum_duration_expired, %{"deadlineGeneration" => generation})
  end

  defp reserve_publication_grant(connection, episode, participant) do
    Postgrex.query!(
      connection,
      """
      insert into sync_publication_grant_reservations
        (tenant_id, space_id, episode_id, reservation_id, operation_id, participant_id,
         participant_generation, source, expires_at)
      values ($1, $2, $3, $4, 'grant_operation_0000001', $5, $6, 'microphone',
              now() + interval '1 minute')
      """,
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(UUID.generate()),
        UUID.dump!(participant.participant_id),
        participant.participant_generation
      ]
    )
  end

  defp make_claimable(connection, external_operation_id) do
    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at = now() where external_operation_id = $1",
      [UUID.dump!(external_operation_id)]
    )
  end
end
