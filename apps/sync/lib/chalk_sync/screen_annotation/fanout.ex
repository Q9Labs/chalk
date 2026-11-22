defmodule ChalkSync.ScreenAnnotation.Fanout do
  @moduledoc "Committed layer invalidations and disposable cross-node presence."

  @behaviour Postgrex.SimpleConnection

  alias ChalkSync.Database
  alias ChalkSync.ScreenAnnotation.Presence
  alias ChalkSync.ScreenAnnotation.PresenceRelay
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias Postgrex.SimpleConnection

  @control_channel "chalk_screen_annotation"
  @presence_channel "chalk_annotation_presence"

  def child_spec(options),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, [options]}}

  def start_link(options) do
    {:ok, opts} = Database.connection_options(Keyword.fetch!(options, :url))
    source = Keyword.fetch!(options, :source_id)

    SimpleConnection.start_link(
      __MODULE__,
      {opts, source},
      opts ++
        [name: Keyword.get(options, :name, __MODULE__), auto_reconnect: true, sync_connect: false]
    )
  end

  @impl true
  def init({opts, source}) do
    :ok = Presence.watch_listener()
    {:ok, publisher} = Postgrex.start_link(opts)

    # A slow presence write must not delay access revocations on the listener.
    {:ok, _relay} = PresenceRelay.start_link(publisher, source, @presence_channel)
    {:ok, source}
  end

  @impl true
  def handle_connect(source),
    do: {:query, "LISTEN #{@control_channel}; LISTEN #{@presence_channel}", source}

  @impl true
  def handle_result([%{command: :listen}, %{command: :listen}], source) do
    :ok = Presence.listener_status(:ready)
    {:noreply, source}
  end

  def handle_result(%Postgrex.Error{} = error, _source), do: raise(error)

  @impl true
  def handle_disconnect(source) do
    :ok = Presence.listener_status(:offline)
    {:noreply, source}
  end

  @impl true
  def notify(@control_channel, payload, _source) do
    with [tenant, space, episode, kind] when kind in ["control", "marks"] <-
           String.split(payload, ":"),
         {:ok, key} <- episode_key([tenant, space, episode]) do
      Presence.change(key, kind == "control")
    end

    :ok
  end

  def notify(@presence_channel, payload, local_source) do
    with {:ok, [source, episode, frame]} <- JSON.decode(payload),
         false <- source == local_source,
         {:ok, key} <- episode_key(episode) do
      Presence.relay(key, frame)
    end

    :ok
  end

  defp episode_key([tenant, space, episode]) do
    if Enum.all?([tenant, space, episode], &match?({:ok, _}, UUID.dump(&1))),
      do: {:ok, %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode}},
      else: :error
  end

  defp episode_key(_invalid), do: :error
end
