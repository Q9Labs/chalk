defmodule ChalkSync.Fanout.Collaboration.PostgresNotifications do
  @moduledoc """
  PostgreSQL `NOTIFY` publisher and strict notification decoder.

  Head notifications contain routing and a durable watermark only. Reaction
  notifications are transient, capped at one KiB, and contain the canonical
  server-stamped event.
  """

  @behaviour ChalkSync.Fanout.Collaboration.Transport

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey

  @head_channel "chalk_collaboration_heads"
  @transient_channel "chalk_collaboration_transient"
  @transient_payload_bytes 1_024
  @uuid ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i

  def head_channel, do: @head_channel
  def transient_channel, do: @transient_channel

  @impl true
  def publish_chat_head(_adapter, %EpisodeKey{} = episode, head) do
    payload =
      encode_payload(%{
        "kind" => "chat_head",
        "tenant_id" => episode.tenant_id,
        "space_id" => episode.space_id,
        "episode_id" => episode.episode_id,
        "head" => wire_head(head)
      })

    notify(episode, @head_channel, payload)
  end

  @impl true
  def publish_reaction(_adapter, %EpisodeKey{} = episode, event) do
    publish_transient(episode, "reaction", event)
  end

  @impl true
  def publish_chat_read_receipt(_adapter, %EpisodeKey{} = episode, receipt) do
    publish_transient(episode, "chat_read_receipt", receipt)
  end

  defp publish_transient(episode, kind, event) do
    payload =
      encode_payload(%{
        "kind" => kind,
        "tenant_id" => episode.tenant_id,
        "space_id" => episode.space_id,
        "episode_id" => episode.episode_id,
        "event" => event
      })

    if byte_size(payload) <= @transient_payload_bytes,
      do: notify(episode, @transient_channel, payload),
      else: {:error, :payload_too_large}
  end

  @spec decode_notification(String.t(), binary()) ::
          {:ok, {:chat_head | :chat_read_receipt | :reaction, EpisodeKey.t(), map()}}
          | {:error, :invalid_payload}
  def decode_notification(channel, payload)
      when channel in [@head_channel, @transient_channel] and is_binary(payload) do
    with {:ok, frame} <- JSON.decode(payload),
         {:ok, episode} <- decode_episode(frame),
         {:ok, kind, value} <- decode_value(channel, frame) do
      {:ok, {kind, episode, value}}
    else
      _ -> {:error, :invalid_payload}
    end
  end

  def decode_notification(_channel, _payload), do: {:error, :invalid_payload}

  defp decode_value(
         @head_channel,
         %{
           "kind" => "chat_head",
           "head" => %{"head_sequence" => head, "retained_floor_sequence" => floor}
         } = payload
       )
       when is_nil(head) or is_binary(head) do
    value = %{
      "type" => "chat_head",
      "head_sequence" => head,
      "retained_floor_sequence" => floor
    }

    if exact_keys?(payload, ["kind", "tenant_id", "space_id", "episode_id", "head"]) and
         GeneratedV1.valid_server_frame?(value),
       do: {:ok, :chat_head, value},
       else: {:error, :invalid_payload}
  end

  defp decode_value(
         @transient_channel,
         %{"kind" => kind, "event" => event} = payload
       )
       when kind in ["reaction", "chat_read_receipt"] do
    decoded_kind = if kind == "reaction", do: :reaction, else: :chat_read_receipt

    if exact_keys?(payload, ["kind", "tenant_id", "space_id", "episode_id", "event"]) and
         GeneratedV1.valid_server_frame?(event),
       do: {:ok, decoded_kind, event},
       else: {:error, :invalid_payload}
  end

  defp decode_value(_channel, _frame), do: {:error, :invalid_payload}

  defp decode_episode(%{
         "tenant_id" => tenant_id,
         "space_id" => space_id,
         "episode_id" => episode_id
       }) do
    if Enum.all?([tenant_id, space_id, episode_id], &(is_binary(&1) and &1 =~ @uuid)) do
      {:ok, %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id}}
    else
      {:error, :invalid_payload}
    end
  end

  defp decode_episode(_frame), do: {:error, :invalid_payload}

  defp wire_head(head) do
    %{
      "head_sequence" => head.head_sequence,
      "retained_floor_sequence" => head.retained_floor_sequence
    }
  end

  defp notify(episode, channel, payload) do
    case Postgrex.query(
           Database.connection(episode),
           "select pg_notify($1, $2)",
           [channel, payload],
           timeout: 1_000
         ) do
      {:ok, _result} -> :ok
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp encode_payload(payload), do: JSON.encode!(payload)

  defp exact_keys?(map, keys),
    do: map_size(map) == length(keys) and Enum.all?(keys, &is_map_key(map, &1))
end
