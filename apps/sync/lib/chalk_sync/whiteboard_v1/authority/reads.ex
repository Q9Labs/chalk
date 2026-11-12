defmodule ChalkSync.WhiteboardV1.Authority.Reads do
  @moduledoc """
  The stored reads of Episode lifecycle states, and the timing of the pollers that write them.

  `Authority` creates the table and answers socket checks from it. Each `Poller` stores into it.
  """

  alias ChalkSync.Stateholder.EpisodeKey

  @table :whiteboard_authority_reads
  @poll_ms 1_000
  @read_ms 1_000

  @spec create_table() :: :ets.table()
  def create_table, do: :ets.new(@table, [:named_table, :public, read_concurrency: true])

  @spec poll_ms() :: pos_integer()
  def poll_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_poll_ms, @poll_ms)

  @spec read_ms() :: pos_integer()
  def read_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_read_ms, @read_ms)

  @doc "Stores the read the calling poller made. The caller's pid names the writer."
  @spec store(EpisodeKey.t(), term(), integer() | nil, String.t() | nil) :: true
  def store(episode, access, read_at, failure),
    do: :ets.insert(@table, {EpisodeKey.authority_key(episode), self(), access, read_at, failure})

  @spec lookup(EpisodeKey.t()) :: {term(), integer() | nil, String.t() | nil} | :missing
  def lookup(episode) do
    case :ets.lookup(@table, EpisodeKey.authority_key(episode)) do
      [{_episode, _poller, access, read_at, failure}] -> {access, read_at, failure}
      [] -> :missing
    end
  end

  @doc "Drops every read the exited poller wrote."
  @spec drop_poller(pid()) :: true
  def drop_poller(poller), do: :ets.match_delete(@table, {:_, poller, :_, :_, :_})
end
