defmodule ChalkSync.Stateholder.TransactionConfigurePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup_all do
    if @database_url do
      [writer, reader] = connections = SyncPostgres.start_connections(@database_url, 2)
      on_exit(fn -> Enum.each(connections, &TestProcess.stop/1) end)
      {:ok, writer: writer, reader: reader}
    else
      :ok
    end
  end

  @tag skip: is_nil(@database_url) && "needs CHALK_SYNC_TEST_DATABASE_URL"
  test "one query applies the settings and returns the rollout state", %{reader: reader} do
    %{rows: [[stored]]} =
      Postgrex.query!(reader, "select enforced from sync_entry_rollout where singleton", [])

    assert {:ok, ^stored} = Postgrex.transaction(reader, &Transaction.configure/1)

    assert {:ok, {"on", "750ms", "2s", "1"}} =
             Postgrex.transaction(reader, fn transaction ->
               Transaction.configure(transaction)

               %{rows: [[synchronous_commit, lock_timeout, statement_timeout, writer]]} =
                 Postgrex.query!(
                   transaction,
                   "select current_setting('synchronous_commit'), current_setting('lock_timeout'), current_setting('statement_timeout'), current_setting('chalk.entry_writer')",
                   []
                 )

               {synchronous_commit, lock_timeout, statement_timeout, writer}
             end)
  end

  # The rollout read shares the settings statement, so lock_timeout must already apply when it
  # waits for the row an enforcing writer holds.
  @tag skip: is_nil(@database_url) && "needs CHALK_SYNC_TEST_DATABASE_URL"
  test "the rollout read waits no longer than lock_timeout", %{writer: writer, reader: reader} do
    holder =
      Task.async(fn ->
        Postgrex.transaction(writer, fn transaction ->
          Postgrex.query!(
            transaction,
            "select 1 from sync_entry_rollout where singleton for update",
            []
          )

          Process.sleep(2_000)
        end)
      end)

    Process.sleep(300)
    started = System.monotonic_time(:millisecond)

    error =
      assert_raise Postgrex.Error, fn ->
        Postgrex.transaction(reader, &Transaction.configure/1)
      end

    assert %{postgres: %{pg_code: "55P03"}} = error
    assert System.monotonic_time(:millisecond) - started < 1_500
    Task.await(holder, 5_000)
  end
end
