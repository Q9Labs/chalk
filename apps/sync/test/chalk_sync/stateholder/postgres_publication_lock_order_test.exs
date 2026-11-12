defmodule ChalkSync.Stateholder.PostgresPublicationLockOrderTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")


  # The API ends an Episode by locking its control row and then the Episode. A publication
  # reservation inserts a row that needs the control row through a foreign key, so it must lock
  # the control row first too. Otherwise each side waits for what the other holds until a lock
  # timeout fails the end request or the reservation.
  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      [api] = SyncPostgres.start_connections(@database_url, 1)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each([api | connections], &TestProcess.stop/1)
      end)

      {:ok, connection: hd(connections), api: api}
    else
      :ok
    end
  end

  test "reserving a publication grant does not hold the Episode while it waits for the control row",
       %{connection: connection, api: api} do
    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    identity = hd(fixture.identities)

    result =
      sync_result_while_api_holds_control(api, fixture.episode, fn ->
        Postgres.reserve_publication_grant(identity, "lock-order-reservation-1", :microphone)
      end)

    assert {:ok, %{reservation_id: _}} = result
  end

  test "completing a publication grant does not hold the Episode while it waits for the control row",
       %{connection: connection, api: api} do
    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    identity = hd(fixture.identities)

    assert {:ok, reservation} =
             Postgres.reserve_publication_grant(identity, "lock-order-reservation-2", :microphone)

    result =
      sync_result_while_api_holds_control(api, fixture.episode, fn ->
        Postgres.complete_publication_grant(
          fixture.episode,
          reservation.reservation_id,
          :confirmed
        )
      end)

    assert {:ok, %{status: :confirmed}} = result
  end

  # Plays an API transaction that holds the control row and asks for the Episode next. Sync
  # must be waiting for the control row, not holding the Episode, so the API gets it at once.
  defp sync_result_while_api_holds_control(api, episode, sync_call) do
    params = Scope.episode(episode)

    {:ok, task} =
      Postgrex.transaction(api, fn connection ->
        %{rows: [[api_pid]]} = Postgrex.query!(connection, "select pg_backend_pid()", [])

        Postgrex.query!(
          connection,
          "select 1 from sync_episode_control where tenant_id=$1 and space_id=$2 and episode_id=$3 for update",
          params
        )

        task = Task.async(sync_call)
        wait_until_blocked_by(connection, api_pid)
        Postgrex.query!(connection, "set local lock_timeout='300ms'", [])

        Postgrex.query!(
          connection,
          "select 1 from episodes where tenant_id=$1 and space_id=$2 and id=$3 for update",
          params
        )

        task
      end)

    Task.await(task, 10_000)
  end

  defp wait_until_blocked_by(connection, blocker_pid, attempts \\ 500) do
    %{rows: [[blocked]]} =
      Postgrex.query!(
        connection,
        "select count(*)::int from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
        [blocker_pid]
      )

    cond do
      blocked > 0 ->
        :ok

      attempts == 0 ->
        flunk("the Sync transaction never waited for the control row")

      true ->
        Process.sleep(10)
        wait_until_blocked_by(connection, blocker_pid, attempts - 1)
    end
  end
end
