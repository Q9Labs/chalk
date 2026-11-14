defmodule ChalkSync.Transport.Socket.Frames do
  @moduledoc """
  Frames a v1 socket sends: the projection context every outbound frame carries, and protocol errors.
  """

  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1

  @off_reason_keys ["off_reason", "off_revision"]

  def encode_with_context(state, encoded) when is_binary(encoded) do
    encode_with_context(state, JSON.decode!(encoded))
  end

  def encode_with_context(state, frame) when is_map(frame) do
    frame
    |> own_identity_projection(state)
    |> device_projection(presence_hint_keys(state))
    |> media_projection(state)
    |> Map.merge(Observability.frame_fields(state.observability))
    |> ProtocolV1.encode!()
  end

  # The authenticated seat can still be pending when its media startup policy runs.
  # Send its verified association privately, without making pending seats public.
  defp own_identity_projection(%{"type" => "welcome", "mode" => mode} = frame, %{
         participant_self_identity: true,
         identity: %{identity_id: identity_id}
       })
       when mode != "terminal" and is_binary(identity_id),
       do: Map.put(frame, "participant_identity_id", identity_id)

  defp own_identity_projection(frame, _state), do: frame

  # Each extension is opt-in so earlier SDKs keep their exact presence wire shape.
  defp presence_hint_keys(%{connection_quality: false} = state),
    do: ["connection_quality" | device_hint_keys(state)]

  defp presence_hint_keys(state), do: device_hint_keys(state)

  defp device_hint_keys(%{participant_devices: false}),
    do: ["identity_id", "device_type", "admission_revision"]

  defp device_hint_keys(%{participant_device_admissions: false}), do: ["admission_revision"]
  defp device_hint_keys(_state), do: []

  defp device_projection(%{"stream" => "presence", "items" => items} = frame, keys),
    do: %{frame | "items" => Enum.map(items, &Map.drop(&1, keys))}

  defp device_projection(%{"stream" => "presence", "item" => item} = frame, keys),
    do: %{frame | "item" => Map.drop(item, keys)}

  defp device_projection(frame, _keys), do: frame

  defp media_projection(frame, %{media_off_reason: true}), do: frame

  defp media_projection(%{"stream" => "media", "items" => items} = frame, _state),
    do: %{frame | "items" => Enum.map(items, &Map.drop(&1, @off_reason_keys))}

  defp media_projection(%{"stream" => "media", "item" => item} = frame, _state),
    do: %{frame | "item" => Map.drop(item, @off_reason_keys)}

  defp media_projection(frame, _state), do: frame

  def device_type(nil), do: nil

  def device_type(agent) do
    cond do
      String.contains?(agent, ["iPad", "Tablet"]) -> "tablet"
      String.contains?(agent, ["Mobile", "iPhone"]) -> "phone"
      String.contains?(agent, ["Windows", "Macintosh", "X11"]) -> "computer"
      true -> nil
    end
  end

  def protocol_error(reason, state),
    do:
      {:push,
       {:text,
        encode_with_context(state, ProtocolV1.error(:protocol_error, Atom.to_string(reason)))},
       state}

  def close_invalid_frame(reason, state) do
    detail =
      if(reason == :unsupported_protocol, do: "unsupported protocol", else: "invalid frame")

    code = if(reason == :unsupported_protocol, do: :unsupported_protocol, else: :invalid_frame)

    {:stop, :normal, {1009, detail},
     {:text, encode_with_context(state, ProtocolV1.error(code, detail))},
     %{state | terminal: %{close_code: 1009, reason: :protocol_error}}}
  end
end
