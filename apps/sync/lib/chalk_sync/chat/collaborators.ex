defmodule ChalkSync.Chat.Collaborators do
  @moduledoc """
  The processes and modules chat and reactions call out to. A caller's option wins, so a test can
  pass its own; `:chat_repository` in app env swaps the repository for a whole run.
  """

  @spec repository(keyword()) :: module()
  def repository(options) do
    Keyword.get(
      options,
      :repository,
      Application.get_env(:chalk_sync, :chat_repository, ChalkSync.Chat.Repository.Postgres)
    )
  end

  @spec fanout(keyword()) :: GenServer.server()
  def fanout(options), do: Keyword.get(options, :fanout, ChalkSync.Fanout.Collaboration)

  @spec admission(keyword()) :: GenServer.server()
  def admission(options), do: Keyword.get(options, :admission, ChalkSync.Admission)
end
