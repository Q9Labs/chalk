defmodule ChalkSync.PostgresCase do
  @moduledoc """
  Runs a test module against the Postgres Stateholder: four connections split over two nodes,
  and a `connection` in the context for fixtures.
  """

  use ExUnit.CaseTemplate

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess

  setup_all do
    connections = SyncPostgres.start_connections(SyncPostgres.database_url!(), 4)

    previous =
      for key <- [:stateholder, :database_connections],
          into: %{},
          do: {key, Application.get_env(:chalk_sync, key)}

    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end
end
