defmodule ChalkSync.Fanout.Collaboration.Transport do
  @moduledoc "Cross-replica transport port for disposable space-action fan-out hints."

  alias ChalkSync.Stateholder.EpisodeKey

  @callback publish_chat_head(term(), EpisodeKey.t(), map()) :: :ok | {:error, atom()}
  @callback publish_chat_read_receipt(term(), EpisodeKey.t(), map()) :: :ok | {:error, atom()}
  @callback publish_reaction(term(), EpisodeKey.t(), map()) :: :ok | {:error, atom()}
end
