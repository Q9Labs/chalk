defmodule ChalkSync.Database.TransactionSettings do
  @moduledoc """
  The durability and timeout settings every Sync transaction starts with.

  Every profile commits synchronously. A profile only changes how long a statement may wait
  for a lock or run. `:entry` also marks the transaction as the writer the API-owned
  entry trigger accepts.
  """

  # The Postgrex timeout of the connection pool is 2 s and stays below this transaction timeout.
  @transaction_timeout_ms 3_000

  @type profile :: :default | :entry | :retention

  @spec transaction_timeout_ms() :: pos_integer()
  def transaction_timeout_ms, do: @transaction_timeout_ms

  @spec sql(profile()) :: String.t()
  def sql(:default), do: build([], "750ms", "2s")
  def sql(:entry), do: build(["set_config('chalk.entry_writer', '1', true)"], "750ms", "2s")
  def sql(:retention), do: build([], "250ms", "30s")

  defp build(leading, lock_timeout, statement_timeout) do
    settings =
      leading ++
        [
          "set_config('lock_timeout', '#{lock_timeout}', true)",
          "set_config('statement_timeout', '#{statement_timeout}', true)",
          "set_config('synchronous_commit', 'on', true)"
        ]

    "select\n  " <> Enum.join(settings, ",\n  ") <> "\n"
  end
end
