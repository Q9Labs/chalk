defmodule ChalkSync.ScreenAnnotation.PresenceRelay do
  @moduledoc false
  use GenServer

  alias ChalkSync.ScreenAnnotation.Presence

  @batch_ms 34

  def start_link(publisher, source, channel),
    do: GenServer.start_link(__MODULE__, {publisher, source, channel})

  @impl true
  def init(state) do
    schedule_flush()
    {:ok, state}
  end

  @impl true
  def handle_info(:flush, {publisher, source, channel} = state) do
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
          "select pg_notify($1, payload) from unnest($2::text[]) as pending(payload)",
          [channel, payloads],
          log: nil,
          timeout: 250
        )
    end

    schedule_flush()
    {:noreply, state}
  end

  defp schedule_flush, do: Process.send_after(self(), :flush, @batch_ms)

  defp key_parts(episode), do: [episode.tenant_id, episode.space_id, episode.episode_id]
end
