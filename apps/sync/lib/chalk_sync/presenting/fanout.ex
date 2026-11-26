defmodule ChalkSync.Presenting.Fanout do
  @moduledoc "Committed presenting invalidations."

  @behaviour Postgrex.SimpleConnection

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias Postgrex.SimpleConnection

  @channel "chalk_presenting"

  def child_spec(options), do: %{id: __MODULE__, start: {__MODULE__, :start_link, [options]}}

  def start_link(options) do
    {:ok, opts} = Database.connection_options(Keyword.fetch!(options, :url))

    SimpleConnection.start_link(
      __MODULE__,
      opts,
      Keyword.merge(opts,
        name: Keyword.get(options, :name, __MODULE__),
        auto_reconnect: true,
        sync_connect: false
      )
    )
  end

  def group(episode), do: {__MODULE__, EpisodeKey.authority_key(episode)}
  def join(episode), do: :pg.join(group(episode), self())
  def leave(episode), do: :pg.leave(group(episode), self())

  @impl true
  def init(opts), do: {:ok, opts}

  @impl true
  def handle_connect(opts), do: {:query, "LISTEN #{@channel}", opts}

  @impl true
  def handle_result([%{command: :listen}], opts), do: {:noreply, opts}
  def handle_result(%Postgrex.Error{} = error, _opts), do: raise(error)

  @impl true
  def handle_disconnect(opts), do: {:noreply, opts}

  @impl true
  def notify(@channel, payload, _opts) do
    with [tenant, space, episode] <- String.split(payload, ":"),
         true <- Enum.all?([tenant, space, episode], &match?({:ok, _}, UUID.dump(&1))) do
      key = %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode}
      for pid <- :pg.get_local_members(group(key)), do: send(pid, :presenting_changed)
    end

    :ok
  end
end
