defmodule ChalkSync.EpisodeLifecycleReplayTest do
  @moduledoc """
  Replays two traces of tools/formal/episode-lifecycle/EpisodeLifecycle.tla
  against the real Postgres transactions:

    * admission can never allocate an entry once the Episode is ending
      (the `admit_ignores_episode_status` break), and
    * the newest confirmed entry's Leave still validates after the end,
      so nobody is left live in an ended Episode.

  The pending-join and admission fences the model also checks
  (`supersede_pending_lifecycle_intents`, `complete_external_episode_admissions`)
  run in the API's end transaction and are covered by its own tests.
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

  test "a pending join admits no seat once the Episode is ending", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    set_status(connection, fixture.episode, "ending")

    assert {:ok, refused} = Postgres.admit_entry(fixture.identity, :legacy)
    assert refused.entry_generation == nil

    assert [] = seats(connection, fixture)
  end

  test "the newest entry's Leave still validates after the Episode ends", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Postgrex.query!(connection, "select enforce_sync_entry_ownership('replay-test')", [])
    {:ok, admitted} = Postgres.admit_entry(fixture.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(admitted)

    on_exit(fn ->
      Postgrex.query!(
        connection,
        "update sync_entry_rollout set enforced=true, enforced_at=now(), release_id='replay-test'",
        []
      )
    end)

    set_status(connection, fixture.episode, "ended")

    assert :ok =
             JoinSeats.validate_leave(
               connection,
               %{fixture.identity | entry_generation: admitted.entry_generation},
               %{name: :participant_leave}
             )
  end

  defp set_status(connection, episode, status) do
    Postgrex.query!(
      connection,
      "update episodes set status=$4 where tenant_id=$1 and space_id=$2 and id=$3",
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        status
      ]
    )
  end

  defp seats(connection, fixture) do
    Postgrex.query!(
      connection,
      "select 1 from participant_join_seats where participant_id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    ).rows
  end
end
