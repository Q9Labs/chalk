defmodule ChalkSync.Stateholder.Postgres.Transaction do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Database.TransactionSettings

  @transaction_timeout_ms TransactionSettings.transaction_timeout_ms()

  def run(episode, fun, options \\ []) do
    Postgrex.transaction(
      Database.connection(episode),
      fun,
      Keyword.put(options, :timeout, @transaction_timeout_ms)
    )
  end

  # Two round trips. The settings query returns the synchronous_commit value Postgres
  # now applies to this transaction, and the rollout row is read under its share lock.
  # Returns whether Sync entry ownership is enforced.
  def configure(connection) do
    %{rows: [[_writer, _lock_timeout, _statement_timeout, setting]]} =
      Postgrex.query!(connection, TransactionSettings.sql(:entry), [], timeout: 2_000)

    unless durable_synchronous_commit?(setting) do
      Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
    end

    %{rows: [[enforced]]} =
      Postgrex.query!(
        connection,
        "select enforced from sync_entry_rollout where singleton for share",
        [],
        timeout: 2_000
      )

    enforced
  end

  def durable_synchronous_commit?(setting), do: setting in ["on", "remote_apply"]
end
