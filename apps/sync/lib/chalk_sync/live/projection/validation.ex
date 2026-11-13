defmodule ChalkSync.Live.Projection.Validation do
  @moduledoc """
  Checks the shape and bounds of projection items.
  """

  alias ChalkSync.UUID

  @limits %{media: 1_500, presence: 500}

  def validate_items(stream, items) when stream in [:media, :presence] do
    limit = Map.fetch!(@limits, stream)

    cond do
      length(items) > limit ->
        {:error, :item_limit}

      Enum.any?(items, &(not valid_item?(stream, &1))) ->
        {:error, :invalid_item}

      items |> Enum.map(&item_key(stream, &1)) |> Enum.uniq() |> length() != length(items) ->
        {:error, :duplicate_item}

      true ->
        :ok
    end
  end

  def validate_items(_stream, _items), do: {:error, :invalid_stream}


  defp valid_item?(:media, item) do
    exact_keys?(
      item,
      ["participant_id", "source", "enabled", "publication_id"] ++
        Enum.filter(["off_reason", "off_revision"], &Map.has_key?(item, &1))
    ) and
      item["source"] in ["microphone", "camera", "screen"] and
      is_boolean(item["enabled"]) and canonical_uuid?(item["participant_id"]) and
      valid_publication(item["enabled"], item["publication_id"]) and valid_off_reason?(item)
  end

  defp valid_item?(:presence, item) do
    exact_keys?(
      item,
      ["participant_id", "state", "speaking", "active_speaker"] ++
        Enum.filter(
          ["identity_id", "device_type", "admission_revision", "connection_quality"],
          &Map.has_key?(item, &1)
        )
    ) and
      valid_presence_hints?(item) and
      item["state"] in ["connected", "disconnected"] and
      canonical_uuid?(item["participant_id"]) and is_boolean(item["speaking"]) and
      is_boolean(item["active_speaker"]) and
      valid_presence_activity?(item)
  end


  defp valid_presence_hints?(item) do
    valid_identity_hint?(item) and valid_device_hint?(item) and valid_admission_hint?(item) and
      valid_connection_quality?(item)
  end


  defp valid_presence_activity?(%{"state" => "connected"}), do: true
  defp valid_presence_activity?(item), do: not item["speaking"] and not item["active_speaker"]


  defp valid_connection_quality?(%{"connection_quality" => quality}),
    do: quality in ["good", "weak", "poor"]

  defp valid_connection_quality?(_item), do: true


  defp valid_identity_hint?(%{"identity_id" => id}), do: canonical_uuid?(id)
  defp valid_identity_hint?(_item), do: true


  defp valid_device_hint?(%{"device_type" => device}),
    do: device in ["phone", "tablet", "computer"]

  defp valid_device_hint?(_item), do: true


  defp valid_admission_hint?(%{"admission_revision" => revision}),
    do: is_integer(revision) and revision > 0

  defp valid_admission_hint?(_item), do: true


  # A device pause or tombstone says why an item is off, so only an off item carries one.
  # A host stop is the latest one for the source and also rides on an item another device
  # of the participant has turned on; it carries the control revision of its stop event.
  defp valid_off_reason?(%{"off_reason" => "host", "off_revision" => revision}),
    do: is_integer(revision) and revision > 0

  defp valid_off_reason?(%{"off_reason" => reason} = item) when reason in ["self", "dead"],
    do: item["enabled"] == false and not Map.has_key?(item, "off_revision")

  defp valid_off_reason?(item),
    do: not Map.has_key?(item, "off_reason") and not Map.has_key?(item, "off_revision")


  defp valid_publication(true, value), do: is_binary(value) and byte_size(value) in 1..256
  defp valid_publication(false, nil), do: true
  defp valid_publication(false, value), do: is_binary(value) and byte_size(value) in 1..256
  defp valid_publication(_enabled, _value), do: false


  defp exact_keys?(item, keys) when is_map(item),
    do: MapSet.new(Map.keys(item)) == MapSet.new(keys)

  defp exact_keys?(_item, _keys), do: false


  def canonical_uuid?(value), do: match?({:ok, _bytes}, UUID.dump(value))


  def item_key(:media, item), do: {item["participant_id"], item["source"]}
  def item_key(:presence, item), do: item["participant_id"]
end
