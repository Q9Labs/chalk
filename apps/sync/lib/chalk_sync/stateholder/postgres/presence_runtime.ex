defmodule ChalkSync.Stateholder.Postgres.PresenceRuntime do
  @moduledoc false

  # A dedicated session is the liveness witness, not a wall-clock heartbeat.
  # Every connect, the first one and each reconnect, runs the startup barrier before the session
  # serves any query. The database may be away at boot: the session keeps retrying in the
  # background, and `Operations` keeps sockets out until the first barrier has passed.
  def child_spec(options), do: %{id: __MODULE__, start: {__MODULE__, :start_link, [options]}}

  def start_link(options) do
    {:ok, connection_options} =
      ChalkSync.Database.connection_options(Keyword.fetch!(options, :url))

    Postgrex.start_link(connection_options ++ [after_connect: &connected/1])
  end

  defp connected(connection) do
    {:ok, :ok} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(
          transaction,
          "update sync_presence_runtime set recover_after=clock_timestamp()+interval '120 seconds' where singleton",
          []
        )

        Postgrex.query!(transaction, "select pg_advisory_lock_shared(1128811595, 1)", [])
        Postgrex.query!(transaction, "select pg_advisory_lock_shared(1128811595, 2)", [])
        :ok
      end)

    ChalkSync.Operations.begin_serving()
  end
end
