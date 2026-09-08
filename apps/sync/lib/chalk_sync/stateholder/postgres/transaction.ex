defmodule ChalkSync.Stateholder.Postgres.Transaction do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.SQL.Transaction, as: SQL

  def configure(connection) do
    Postgrex.query!(connection, SQL.transaction_settings(), [], timeout: 2_000)
    %{rows: [[setting]]} = Postgrex.query!(connection, SQL.effective_synchronous_commit(), [])

    unless durable_synchronous_commit?(setting) do
      Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
    end
  end

  def durable_synchronous_commit?(setting), do: setting in ["on", "remote_apply"]
end
