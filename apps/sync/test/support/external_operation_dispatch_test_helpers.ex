defmodule ChalkSync.ExternalOperationDispatchTestHelpers do
  @moduledoc false

  import ExUnit.Assertions

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  def fixture(connection, count) do
    SyncPostgres.seed_episode(connection, count, %{}, %{
      participants: List.duplicate(%{role: "owner"}, count)
    })
  end

  def queue(identity, name, payload \\ %{}) do
    {:ok, operation} = Operation.new("judge_" <> UUID.generate(), name, payload)
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(identity, operation)
    assert is_binary(id)
    id
  end

  def expire_fences(connection, seed) do
    Postgrex.query!(
      connection,
      "update sync_publication_fences set created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' where episode_id=$1",
      [UUID.dump!(seed.episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now()-interval '1 hour' where episode_id=$1",
      [UUID.dump!(seed.episode.episode_id)]
    )
  end

  def assert_pending_count(connection, seed, count) do
    %{rows: [[^count]]} =
      Postgrex.query!(
        connection,
        "select count(*) from sync_external_operations where episode_id=$1 and status='pending'",
        [UUID.dump!(seed.episode.episode_id)]
      )
  end

  def assert_ended(connection, seed) do
    %{rows: [["ended"]]} =
      Postgrex.query!(connection, "select status from episodes where id=$1", [
        UUID.dump!(seed.episode.episode_id)
      ])

    %{rows: [[1]]} =
      Postgrex.query!(
        connection,
        "select count(*) from sync_control_events where episode_id=$1 and event_name='participant_left'",
        [UUID.dump!(seed.episode.episode_id)]
      )

    assert {:ok, []} = Postgres.claim_operations(8)
  end
end
