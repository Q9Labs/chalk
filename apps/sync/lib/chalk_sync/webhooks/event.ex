defmodule ChalkSync.Webhooks.Event do
  @moduledoc false

  @api_version 1
  @max_body_bytes 256 * 1024
  @uuid_v4 ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

  @spec encode!(String.t(), String.t(), String.t(), DateTime.t(), map()) :: binary()
  def encode!(event_id, event_name, tenant_id, occurred_at, object)
      when event_name in ["participant.joined", "participant.left", "session.ended"] do
    validate_uuid!(event_id, :event_id)
    validate_uuid!(tenant_id, :tenant_id)
    validate_datetime!(occurred_at, :occurred_at)
    validate_object!(event_name, object)

    body =
      IO.iodata_to_binary([
        ~s({"id":),
        JSON.encode!(event_id),
        ~s(,"event":),
        JSON.encode!(event_name),
        ~s(,"api_version":),
        Integer.to_string(@api_version),
        ~s(,"occurred_at":),
        JSON.encode!(timestamp(occurred_at)),
        ~s(,"tenant_id":),
        JSON.encode!(tenant_id),
        ~s(,"data":{"object":),
        encode_object(event_name, object),
        "}}"
      ])

    if byte_size(body) > @max_body_bytes,
      do: raise(ArgumentError, "webhook Event body exceeds 256 KiB")

    body
  end

  @spec normalize_timestamp!(DateTime.t()) :: DateTime.t()
  def normalize_timestamp!(%DateTime{} = value) do
    value |> DateTime.to_unix(:millisecond) |> DateTime.from_unix!(:millisecond)
  end

  def normalize_timestamp!(_value), do: invalid!(:timestamp)

  defp encode_object(event_name, object)
       when event_name in ["participant.joined", "participant.left"] do
    encode_fields([
      {"id", object.id},
      {"user_id", object.user_id},
      {"room_id", object.room_id},
      {"session_id", object.session_id},
      {"name", object.name},
      {"status", object.status},
      {"joined_at", nullable_timestamp(object.joined_at)},
      {"left_at", nullable_timestamp(object.left_at)}
    ])
  end

  defp encode_object("session.ended", object) do
    encode_fields([
      {"id", object.id},
      {"room_id", object.room_id},
      {"status", object.status},
      {"started_at", nullable_timestamp(object.started_at)},
      {"ended_at", nullable_timestamp(object.ended_at)},
      {"created_at", timestamp(object.created_at)},
      {"updated_at", timestamp(object.updated_at)}
    ])
  end

  defp validate_object!(event_name, object)
       when event_name in ["participant.joined", "participant.left"] and is_map(object) do
    validate_uuid!(Map.get(object, :id), :participant_id)
    validate_nullable_uuid!(Map.get(object, :user_id), :user_id)
    validate_uuid!(Map.get(object, :room_id), :room_id)
    validate_uuid!(Map.get(object, :session_id), :session_id)

    unless is_nil(Map.get(object, :name)) or is_binary(Map.get(object, :name)),
      do: invalid!(:name)

    validate_datetime!(Map.get(object, :joined_at), :joined_at)

    case {event_name, Map.get(object, :status), Map.get(object, :left_at)} do
      {"participant.joined", "active", nil} -> :ok
      {"participant.left", "left", %DateTime{}} -> :ok
      _ -> invalid!(:participant_snapshot)
    end
  end

  defp validate_object!("session.ended", object) when is_map(object) do
    validate_uuid!(Map.get(object, :id), :session_id)
    validate_uuid!(Map.get(object, :room_id), :room_id)

    unless Map.get(object, :status) == "ended", do: invalid!(:session_status)

    Enum.each([:started_at, :ended_at, :created_at, :updated_at], fn field ->
      validate_datetime!(Map.get(object, field), field)
    end)
  end

  defp validate_object!(_event_name, _object), do: invalid!(:object)

  defp validate_uuid!(value, _field) when is_binary(value) do
    if Regex.match?(@uuid_v4, value), do: :ok, else: invalid!(:uuid)
  end

  defp validate_uuid!(_value, _field), do: invalid!(:uuid)
  defp validate_nullable_uuid!(nil, _field), do: :ok
  defp validate_nullable_uuid!(value, field), do: validate_uuid!(value, field)
  defp validate_datetime!(%DateTime{}, _field), do: :ok
  defp validate_datetime!(_value, field), do: invalid!(field)

  defp invalid!(field), do: raise(ArgumentError, "invalid webhook Event #{field}")

  defp encode_fields(fields) do
    members =
      Enum.map(fields, fn {key, value} -> [JSON.encode!(key), ":", JSON.encode!(value)] end)

    IO.iodata_to_binary(["{", Enum.intersperse(members, ","), "}"])
  end

  defp nullable_timestamp(nil), do: nil
  defp nullable_timestamp(value), do: timestamp(value)

  defp timestamp(%DateTime{} = value) do
    truncated = normalize_timestamp!(value)
    milliseconds = truncated.microsecond |> elem(0) |> div(1_000)

    Calendar.strftime(truncated, "%Y-%m-%dT%H:%M:%S") <>
      "." <> String.pad_leading(Integer.to_string(milliseconds), 3, "0") <> "Z"
  end
end
