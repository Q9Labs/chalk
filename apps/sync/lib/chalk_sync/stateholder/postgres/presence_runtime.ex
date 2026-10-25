defmodule ChalkSync.Stateholder.Postgres.PresenceRuntime do
  @moduledoc false

  # A dedicated session is the liveness witness, not a wall-clock heartbeat.
  # Reconnect runs the same startup barrier before it advertises availability.
  def child_spec(options), do: %{id: __MODULE__, start: {__MODULE__, :start_link, [options]}}

  def start_link(options) do
    {:ok, connection_options} =
      ChalkSync.Database.connection_options(Keyword.fetch!(options, :url))

    with {:ok, connection} <-
           Postgrex.start_link(
             connection_options ++ [sync_connect: true, after_connect: &connected/1]
           ) do
      # after_connect is asynchronous; a query waits for its barrier before the
      # application supervisor starts the listener.
      Postgrex.query!(connection, "select 1", [])
      {:ok, connection}
    end
  end

  defp connected(connection) do
    {:ok, :ok} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          "update participant_presence_runtime set recover_after=clock_timestamp()+interval '120 seconds' where singleton",
          []
        )

        Postgrex.query!(transaction, "select pg_advisory_lock_shared(1128811595, 1)", [])
        :ok
      end)
  end
end
