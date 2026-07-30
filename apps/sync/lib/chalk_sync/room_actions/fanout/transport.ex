defmodule ChalkSync.RoomActions.Fanout.Transport do
  @moduledoc "Cross-replica transport port for disposable room-action fan-out hints."

  alias ChalkSync.Stateholder.SessionKey

  @callback publish_chat_head(term(), SessionKey.t(), map()) :: :ok | {:error, atom()}
  @callback publish_chat_read_receipt(term(), SessionKey.t(), map()) :: :ok | {:error, atom()}
  @callback publish_reaction(term(), SessionKey.t(), map()) :: :ok | {:error, atom()}
end
