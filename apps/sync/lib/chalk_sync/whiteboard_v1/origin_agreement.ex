defmodule ChalkSync.WhiteboardV1.OriginAgreement do
  @moduledoc false
  require Logger

  @lease_ms 6000
  @capacity 256

  def new(fingerprint, now) do
    %{fingerprint: fingerprint, peers: %{}, discover_until: now + 2000, overflow_until: now}
  end

  def observe(state, source, fingerprint, now) do
    state = expire(state, now)

    if map_size(state.peers) < @capacity or Map.has_key?(state.peers, source) do
      previous = Map.get(state.peers, source)

      if fingerprint != state.fingerprint and
           (is_nil(previous) or previous.fingerprint != fingerprint) do
        Logger.error(
          "whiteboard origin secret mismatch local_fingerprint=#{state.fingerprint} peer_fingerprint=#{fingerprint}"
        )

        :telemetry.execute([:chalk_sync, :whiteboard, :origin_secret_mismatch], %{count: 1}, %{})
      end

      %{
        state
        | peers:
            Map.put(state.peers, source, %{fingerprint: fingerprint, expires: now + @lease_ms})
      }
    else
      %{state | overflow_until: now + @lease_ms}
    end
  end

  def status(state, now) do
    cond do
      now < state.discover_until ->
        {:error, :view_origin_peer_discovery}

      now < state.overflow_until ->
        {:error, :view_origin_peer_capacity}

      Enum.any?(state.peers, fn {_source, peer} ->
        peer.expires > now and peer.fingerprint != state.fingerprint
      end) ->
        {:error, :view_origin_secret_mismatch}

      true ->
        :ok
    end
  end

  defp expire(state, now) do
    %{state | peers: Map.reject(state.peers, fn {_source, peer} -> peer.expires <= now end)}
  end
end
