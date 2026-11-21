defmodule ChalkSync.ScreenAnnotation.Fanout do
  @moduledoc "Committed layer invalidations and disposable cross-node presence."

  use GenServer

  alias ChalkSync.Database
  alias ChalkSync.ScreenAnnotation.Presence
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  @control_channel "chalk_screen_annotation"
  @presence_channel "chalk_annotation_presence"
  @batch_ms 34

  def start_link(options),
    do: GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))

  @impl true
  def init(options) do
    {:ok, opts} = Database.connection_options(Keyword.fetch!(options, :url))

    {:ok, notifications} =
      Postgrex.Notifications.start_link(Keyword.put(opts, :auto_reconnect, true))

    control_ref = Database.listen(notifications, @control_channel)
    presence_ref = Database.listen(notifications, @presence_channel)
    {:ok, publisher} = Postgrex.start_link(opts)

    # Publication uses a worker separate from the listener. A slow database
    # network write must not delay access revocation processing.
    {:ok, relay} =
      Task.start_link(fn -> relay_loop(publisher, Keyword.fetch!(options, :source_id)) end)

    {:ok,
     %{
       notifications: notifications,
       control_ref: control_ref,
       presence_ref: presence_ref,
       relay: relay,
       source_id: Keyword.fetch!(options, :source_id)
     }}
  end

  @impl true
  def handle_info(
        {:notification, notifications, ref, @control_channel, payload},
        %{notifications: notifications, control_ref: ref} = state
      ) do
    with [tenant, space, episode, kind] when kind in ["control", "marks"] <-
           String.split(payload, ":"),
         {:ok, key} <- episode_key([tenant, space, episode]) do
      Presence.change(key, kind == "control")
    end

    {:noreply, state}
  end

  def handle_info(
        {:notification, notifications, ref, @presence_channel, payload},
        %{notifications: notifications, presence_ref: ref} = state
      ) do
    with {:ok, [source, episode, frame]} <- JSON.decode(payload),
         false <- source == state.source_id,
         {:ok, key} <- episode_key(episode) do
      Presence.relay(key, frame)
    end

    {:noreply, state}
  end

  defp relay_loop(publisher, source) do
    Process.sleep(@batch_ms)
    now = System.system_time(:millisecond)

    payloads =
      for {episode, sample} <- Presence.take_relay(),
          sample["expires_at_ms"] > now,
          payload = JSON.encode!([source, key_parts(episode), sample]),
          byte_size(payload) < 8_000,
          do: payload

    if payloads != [] do
      _ =
        Postgrex.query(
          publisher,
          "select pg_notify('#{@presence_channel}', payload) from unnest($1::text[]) as pending(payload)",
          [payloads],
          log: nil,
          timeout: 250
        )
    end

    relay_loop(publisher, source)
  end

  defp key_parts(episode), do: [episode.tenant_id, episode.space_id, episode.episode_id]

  defp episode_key([tenant, space, episode]) do
    if Enum.all?([tenant, space, episode], &match?({:ok, _}, UUID.dump(&1))),
      do: {:ok, %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode}},
      else: :error
  end

  defp episode_key(_invalid), do: :error
end
