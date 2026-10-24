defmodule ChalkSync.RollingEntryPostgresTest do
  use ExUnit.Case, async: false
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")
  @fixture Path.expand("../fixtures/production-670d7c09", __DIR__)

  @moduletag timeout: 180_000
  setup_all do
    root = Path.join(System.tmp_dir!(), "chalk-rolling-#{UUID.generate()}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    archive = File.read!(Path.join(@fixture, "source.tar.gz"))

    assert Base.encode16(:crypto.hash(:sha256, archive), case: :lower) ==
             "fb477506368eab4ba46af2aa9a9b411426ce8106e41c563dcf3dca043d32c455"

    :ok = :erl_tar.extract({:binary, archive}, [:compressed, {:cwd, String.to_charlist(root)}])
    old = Path.join(root, "apps/sync")

    for args <- [["deps.get", "--check-locked"], ["compile"]] do
      {output, code} =
        System.cmd("mix", args, cd: old, env: [{"MIX_ENV", "test"}], stderr_to_stdout: true)

      assert code == 0, output
    end

    %{old: old}
  end

  setup do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url)
    Enum.each(connections, &Process.unlink/1)
    connection = hd(connections)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    policy(connection, false)
    fixture = SyncPostgres.seed_pending_join(connection)
    # Exercise the real transaction marker, independent of fixture sessions.
    Enum.each(connections, fn connection ->
      Postgrex.query!(connection, "select set_config('chalk.entry_writer','',false)", [])
    end)

    on_exit(fn ->
      policy(connection, true)
      SyncPostgres.cleanup(connection, fixture.episode)
      Application.put_env(:chalk_sync, :database_connections, previous)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    %{connection: connection, identity: fixture.identity}
  end

  for expired <- [false, true] do
    @tag :rolling_reproduction
    test "old-applied join reconciles its #{if expired, do: "expired", else: "pending"} seat",
         ctx do
      {:ok, admitted} = Postgres.admit_entry(ctx.identity, :legacy)
      assert old(ctx, "join") == 0

      if unquote(expired) do
        Postgrex.query!(
          ctx.connection,
          "update participant_join_seats set expires_at=now()-interval '1 minute', issued_entry_expires_at=now()-interval '1 minute' where participant_id=$1",
          [UUID.dump!(ctx.identity.participant_id)]
        )
      end

      enforce(ctx.connection)
      assert {:ok, _} = Postgres.confirm_admission(admitted)
      {:ok, reconnect} = Postgres.admit_entry(ctx.identity, :legacy)
      assert {:ok, _} = Postgres.confirm_admission(reconnect)
      assert rows(ctx) == [["active", "joined", 2, 2]]
    end
  end

  @tag :rolling_reproduction
  test "old Leave cannot remove a confirmed replacement after enforcement, including rollback",
       ctx do
    assert old(ctx, "join") == 0
    enforce(ctx.connection)
    {:ok, current} = Postgres.admit_entry(ctx.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(current)
    result = old(ctx, "leave")
    assert rows(ctx) == [["active", "joined", 1, 1]]
    assert result == 10
    # Starting the old application again models rollback to an obsolete writer.
    assert old(ctx, "leave") == 10
    assert rows(ctx) == [["active", "joined", 1, 1]]
  end

  test "a Leave accepted before enforcement cannot finalize after a replacement", ctx do
    assert old(ctx, "join") == 0
    assert old(ctx, "accept") == 0
    enforce(ctx.connection)
    {:ok, current} = Postgres.admit_entry(ctx.identity, :legacy)
    assert {:ok, _} = Postgres.confirm_admission(current)
    assert old(ctx, "finalize") == 0
    assert rows(ctx) == [["active", "joined", 1, 1]]
  end

  test "enforcement waits for a claimed Leave to finish", ctx do
    assert old(ctx, "join") == 0
    assert old(ctx, "accept") == 0

    Postgrex.query!(
      ctx.connection,
      "update sync_external_operations set attempt_count=1 where target_participant_id=$1 and operation_name='participant_leave'",
      [UUID.dump!(ctx.identity.participant_id)]
    )

    assert {:error, %Postgrex.Error{postgres: %{code: :object_not_in_prerequisite_state}}} =
             Postgrex.query(
               ctx.connection,
               "select enforce_sync_entry_ownership('rolling-test')",
               []
             )

    assert [[false]] =
             Postgrex.query!(ctx.connection, "select enforced from sync_entry_rollout", []).rows

    assert old(ctx, "leave") == 0
    enforce(ctx.connection)
  end

  test "a current old socket can leave through the new consumer after enforcement", ctx do
    assert old(ctx, "join") == 0
    enforce(ctx.connection)
    assert old(ctx, "accept") == 0
    # An old consumer must not dispatch provider work after the switch.
    assert old(ctx, "claim") == 10
    assert {:ok, [{episode, operation}]} = Postgres.claim_operations(64)
    assert :ready = Postgres.prepare_entry_leave(episode, operation.external_operation_id)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               episode,
               operation.external_operation_id,
               {:confirmed, :provider}
             )

    assert [["left"]] =
             Postgrex.query!(ctx.connection, "select status from participants where id=$1", [
               UUID.dump!(ctx.identity.participant_id)
             ]).rows
  end

  test "expand sockets do not acquire owned entries", ctx do
    assert {:ok, %{entry_generation: nil}} = Postgres.admit_entry(ctx.identity, {:socket, :new})
    assert old(ctx, "join") == 0
    assert old(ctx, "leave") == 0
    assert [["left", "left", 0, 0]] = rows(ctx)
  end

  defp old(ctx, action) do
    i = ctx.identity

    {output, code} =
      System.cmd(
        "mix",
        [
          "run",
          Path.join(@fixture, "action.exs"),
          action,
          i.episode.tenant_id,
          i.episode.space_id,
          i.episode.episode_id,
          i.participant_id,
          i.admission_lifecycle_intent_id
        ],
        cd: ctx.old,
        env: [{"MIX_ENV", "test"}, {"CHALK_SYNC_TEST_DATABASE_URL", @database_url}],
        stderr_to_stdout: true
      )

    assert code in [0, 10], output
    code
  end

  defp rows(ctx),
    do:
      Postgrex.query!(
        ctx.connection,
        "select p.status,s.state,s.issued_entry_generation,s.confirmed_entry_generation from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
        [UUID.dump!(ctx.identity.participant_id)]
      ).rows

  defp policy(connection, enabled),
    do:
      Postgrex.query!(
        connection,
        "update sync_entry_rollout set enforced=$1,enforced_at=case when $1 then now() end,release_id=case when $1 then 'test' end",
        [enabled]
      )

  defp enforce(connection),
    do: Postgrex.query!(connection, "select enforce_sync_entry_ownership('rolling-test')", [])
end
