defmodule ChalkSync.Presenting.RepositoryLifecycleTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Presenting.Housekeeping
  alias ChalkSync.Presenting.Repository
  alias ChalkSync.UUID

  import ChalkSync.Presenting.RepositoryFixtures

  setup %{connections: connections} do
    connection = hd(connections)

    fixture =
      ChalkSync.SyncPostgres.seed_episode(connection, 3, %{}, %{
        participants: [
          %{role: "owner"},
          %{role: "collaborator", capabilities: ["subscribe"]},
          %{role: "collaborator"}
        ]
      })

    on_exit(fn ->
      cleanup_presenting(connection, fixture.episode)
      ChalkSync.SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok,
     connection: connection,
     api: Enum.at(connections, 2),
     host: hd(fixture.identities),
     participant: Enum.at(fixture.identities, 1),
     presenter: List.last(fixture.identities)}
  end

  test "the Episode end trigger can lock Stage state while a command waits for the Episode",
       ctx do
    assert {:ok, %{"kind" => "accepted"}} =
             Repository.command(ctx.host, frame("present", attachment(ctx)))

    params = episode_params(ctx.host)

    assert {:error, "not_active"} =
             lifecycle_trigger_result(
               ctx,
               "select status from episodes where tenant_id = $1 and space_id = $2 and id = $3 for update",
               "update episodes set status = 'ended' where tenant_id = $1 and space_id = $2 and id = $3",
               params
             )
  end

  test "the participant leave trigger can lock Stage Documents while a command waits for the participant",
       ctx do
    assert {:ok, %{"kind" => "accepted"}} =
             Repository.command(ctx.host, frame("present", attachment(ctx)))

    params =
      episode_params(ctx.host) ++
        [UUID.dump!(ctx.host.participant_id), ctx.host.participant_generation]

    assert {:error, "not_active"} =
             lifecycle_trigger_result(
               ctx,
               """
               select status from participants
               where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5
               for update
               """,
               """
               update participants set status = 'left', left_at = now()
               where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5
               """,
               params
             )
  end

  test "expired operation receipts are swept and fresh receipts stay", ctx do
    first = frame("present", attachment(ctx))
    second = frame("present", attachment(ctx))
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, first)
    assert {:ok, %{"revision" => 2}} = Repository.command(ctx.host, second)

    params = [
      UUID.dump!(ctx.host.episode.tenant_id),
      UUID.dump!(ctx.host.episode.space_id),
      UUID.dump!(ctx.host.episode.episode_id),
      Base.decode16!(String.replace(first["operation_id"], "-", ""), case: :lower)
    ]

    Postgrex.query!(
      ctx.connection,
      """
      update sync_presenting_receipts set expires_at_ms = 1
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and operation_id = $4
      """,
      params
    )

    assert :ok = Housekeeping.sweep(ctx.connection)

    assert %{rows: [[1]]} =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_presenting_receipts where tenant_id = $1 and space_id = $2 and episode_id = $3",
               Enum.take(params, 3)
             )
  end

  defp lifecycle_trigger_result(ctx, lock_sql, update_sql, params) do
    blocked_document = attachment(ctx)

    {:ok, task} =
      Postgrex.transaction(ctx.api, fn transaction ->
        %{rows: [[api_pid]]} = Postgrex.query!(transaction, "select pg_backend_pid()", [])
        Postgrex.query!(transaction, lock_sql, params)

        task =
          Task.async(fn ->
            Repository.command(ctx.host, frame("present", blocked_document))
          end)

        wait_until_blocked_by(transaction, api_pid)
        Postgrex.query!(transaction, "set local lock_timeout = '300ms'", [])
        Postgrex.query!(transaction, update_sql, params)
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
        flunk("the presenting command never waited for the lifecycle lock")

      true ->
        Process.sleep(10)
        wait_until_blocked_by(connection, blocker_pid, attempts - 1)
    end
  end

  defp episode_params(identity) do
    [
      UUID.dump!(identity.episode.tenant_id),
      UUID.dump!(identity.episode.space_id),
      UUID.dump!(identity.episode.episode_id)
    ]
  end
end
