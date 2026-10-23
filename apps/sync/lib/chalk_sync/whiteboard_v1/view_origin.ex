defmodule ChalkSync.WhiteboardV1.ViewOrigin do
  @moduledoc false

  alias ChalkSync.WhiteboardV1.ViewClock

  def fingerprint do
    secret = Application.fetch_env!(:chalk_sync, :view_origin_secret)

    :crypto.mac(:hmac, :sha256, secret, "chalk-view-origin-peer-agreement-v1")
    |> Base.encode16(case: :lower)
  end

  # Episode keys derive from one environment-wide secret, never database state.
  # A restore therefore cannot split keys between surviving and new sockets.
  defp mac(episode, payload) do
    secret = Application.fetch_env!(:chalk_sync, :view_origin_secret)
    context = {"chalk-view-origin-v2", episode.tenant_id, episode.space_id, episode.episode_id}
    key = :crypto.mac(:hmac, :sha256, secret, :erlang.term_to_binary(context))

    :crypto.mac(:hmac, :sha256, key, :erlang.term_to_binary(payload))
    |> Base.encode16(case: :lower)
  end

  def stamp(view, episode, time) do
    certificate =
      mac(episode, {:lead, view.origin_participant_id, view.origin_connection_id, time})

    "#{time}:#{certificate}"
  end

  def stamp_time(view, episode) do
    with [time, certificate] <- String.split(view.origin_lead_stamp, ":"),
         {value, ""} <- Integer.parse(time),
         expected <- stamp(view, episode, value),
         true <- :crypto.hash_equals("#{time}:#{certificate}", expected) do
      {:ok, value}
    else
      _ -> {:error, :invalid_origin_proof}
    end
  end

  def lead(view, episode, clock \\ ViewClock) do
    # The all-zero certificate means this authenticated tab has not led yet.
    neutral = view.origin_lead_stamp == "0:" <> String.duplicate("0", 64)
    previous = if neutral, do: {:ok, 0}, else: stamp_time(view, episode)

    with {:ok, time} <- previous,
         {:ok, high} <- ViewClock.advance(episode, time, view.lead, clock) do
      next = if view.lead, do: high, else: time
      {:ok, Map.put(view, :origin_lead_stamp, stamp(view, episode, next))}
    end
  end

  # Authenticate geometry too. A relay may suppress Bring, never add it.
  def sign(view, episode) do
    payload =
      {2, view.origin_participant_id, view.origin_connection_id, view.origin_lead_stamp,
       view.origin_epoch, view.origin_sequence, number(view.x), number(view.y),
       number(view.width), number(view.height), view.bring}

    mac(episode, payload)
  end

  def valid?(view, episode, clock \\ ViewClock)

  def valid?(%{origin_proof: proof} = view, episode, clock)
      when is_binary(proof) and byte_size(proof) == 64 do
    with true <-
           :crypto.hash_equals(proof, sign(view, episode)) or
             (not view.bring and :crypto.hash_equals(proof, sign(%{view | bring: true}, episode))),
         {:ok, time} <- stamp_time(view, episode),
         {:ok, _high} <- ViewClock.advance(episode, time, false, clock) do
      true
    else
      _ -> false
    end
  end

  def valid?(_view, _episode, _clock), do: false

  defp number(value) when value == 0, do: 0.0
  defp number(value), do: value / 1
end
