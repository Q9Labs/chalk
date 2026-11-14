defmodule ChalkSync.Chat.PersonLimitsCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess

  using do
    quote do
      import ChalkSync.Chat.PersonLimitsCase
    end
  end

  defp database_url do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
      System.get_env("CHALK_DATABASE_URL")
  end

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(database_url(), 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}]
      })

    on_exit(fn ->
      Application.delete_env(:chalk_sync, :chat_person_limits)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok, fixture: fixture, fanout: start_supervised!({Collaboration, name: nil})}
  end

  def limit(limits), do: Application.put_env(:chalk_sync, :chat_person_limits, Map.new(limits))

  def chat(client_message_id, text \\ "Hello"),
    do: %{client_message_id: "#{client_message_id}-0000000000", text: text, attachment_ids: []}
end
