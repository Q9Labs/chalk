defmodule ChalkSync.Live.Projection do
  @moduledoc "Bounded latest-replace media and presence projections."

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Live.Projection.Validation
  alias ChalkSync.UUID

  @protocol_limits GeneratedV1.limits()
  @snapshot_byte_limit @protocol_limits["projectionSnapshotEncodedBytes"]
  @event_byte_limit @protocol_limits["encodedLiveEventBytes"]
  @correlation_reserved_bytes @protocol_limits["correlationReservedBytes"]
  @snapshot_producer_byte_limit @snapshot_byte_limit - @correlation_reserved_bytes
  @event_producer_byte_limit @event_byte_limit - @correlation_reserved_bytes
  @default_max_age_ms 30_000
  @limits %{media: 1_500, presence: 500}

  @enforce_keys [:stream, :projection_id, :sequence, :items, :created_at_ms, :max_age_ms]
  defstruct [:stream, :projection_id, :sequence, :items, :created_at_ms, :max_age_ms]

  @opaque t :: %__MODULE__{
            stream: :media | :presence,
            projection_id: String.t(),
            sequence: non_neg_integer(),
            items: map(),
            created_at_ms: integer(),
            max_age_ms: pos_integer()
          }

  @spec replace(:media | :presence, [map()], keyword()) ::
          {:ok, t(), map()} | {:error, atom()}
  def replace(stream, items, options \\ []) when is_list(items) do
    now_ms = Keyword.get(options, :now_ms, System.monotonic_time(:millisecond))
    id_generator = Keyword.get(options, :id_generator, &UUID.generate/0)
    max_age_ms = Keyword.get(options, :max_age_ms, @default_max_age_ms)

    with :ok <- Validation.validate_items(stream, items),
         true <- max_age_ms > 0,
         projection_id = id_generator.(),
         true <- Validation.canonical_uuid?(projection_id),
         frame = snapshot_frame(stream, projection_id, items),
         :ok <- encoded_bound(frame, @snapshot_producer_byte_limit) do
      projection = %__MODULE__{
        stream: stream,
        projection_id: projection_id,
        sequence: 0,
        items: Map.new(items, &{Validation.item_key(stream, &1), &1}),
        created_at_ms: now_ms,
        max_age_ms: max_age_ms
      }

      {:ok, projection, frame}
    else
      false -> {:error, :invalid_projection}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec apply_event(t(), map(), integer()) :: {:ok, t()} | {:error, atom()}
  def apply_event(%__MODULE__{} = projection, frame, now_ms) when is_map(frame) do
    with :ok <- fresh(projection, now_ms),
         :ok <- exact_event_fields(frame),
         true <- frame["stream"] == Atom.to_string(projection.stream),
         true <- frame["projection_id"] == projection.projection_id,
         true <- frame["sequence"] == projection.sequence + 1,
         :ok <- Validation.validate_items(projection.stream, [frame["item"]]),
         :ok <- encoded_bound(frame, @event_producer_byte_limit),
         items =
           Map.put(
             projection.items,
             Validation.item_key(projection.stream, frame["item"]),
             frame["item"]
           ),
         true <- map_size(items) <= Map.fetch!(@limits, projection.stream),
         :ok <-
           encoded_bound(
             snapshot_frame(projection.stream, projection.projection_id, Map.values(items)),
             @snapshot_producer_byte_limit
           ) do
      {:ok, %{projection | sequence: frame["sequence"], items: items}}
    else
      false -> event_error(projection, frame)
      {:error, reason} -> {:error, reason}
    end
  end

  @spec reconcile(t(), [map()], keyword()) :: {:ok, t(), [map()]} | {:error, atom()}
  def reconcile(%__MODULE__{} = projection, desired_items, options \\ [])
      when is_list(desired_items) do
    now_ms = Keyword.get(options, :now_ms, System.monotonic_time(:millisecond))

    case Validation.validate_items(projection.stream, desired_items) do
      :ok ->
        desired = Map.new(desired_items, &{Validation.item_key(projection.stream, &1), &1})

        case fresh(projection, now_ms) do
          :ok ->
            changes = changes(projection, desired)
            reconcile_changes(projection, desired_items, changes, options, now_ms)

          {:error, :stale_projection} ->
            rotate(projection, desired_items, options)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec items(t()) :: [map()]
  def items(%__MODULE__{} = projection) do
    projection.items
    |> Map.values()
    |> Enum.sort_by(&Validation.item_key(projection.stream, &1))
  end

  defp fresh(projection, now_ms) do
    if now_ms - projection.created_at_ms < projection.max_age_ms,
      do: :ok,
      else: {:error, :stale_projection}
  end

  defp exact_event_fields(frame) do
    if MapSet.new(Map.keys(frame)) ==
         MapSet.new(["type", "stream", "projection_id", "sequence", "item"]) and
         frame["type"] == "projection_event" do
      :ok
    else
      {:error, :invalid_event}
    end
  end

  defp changes(projection, desired) do
    existing_changes =
      projection.items
      |> Map.values()
      |> Enum.map(&existing_change(projection.stream, desired, &1))

    additions =
      desired
      |> Enum.reject(fn {key, _item} -> Map.has_key?(projection.items, key) end)

    (existing_changes ++ additions)
    |> Enum.reject(&is_nil/1)
    |> Enum.sort_by(fn {key, _item} -> key end)
  end

  defp existing_change(stream, desired, current) do
    key = Validation.item_key(stream, current)

    case Map.fetch(desired, key) do
      {:ok, desired_item} -> maybe_change(key, current, desired_item)
      :error -> maybe_change(key, current, tombstone(stream, current))
    end
  end

  defp maybe_change(key, current, next) do
    case current == next do
      true -> nil
      false -> {key, next}
    end
  end

  # A removed item keeps no reason: nothing says why it went away.
  defp tombstone(:media, item) do
    item
    |> Map.drop(["off_reason", "off_revision"])
    |> Map.merge(%{"enabled" => false, "publication_id" => nil})
  end

  defp tombstone(:presence, item) do
    %{item | "state" => "disconnected", "speaking" => false, "active_speaker" => false}
    |> Map.delete("connection_quality")
  end

  defp reconcile_changes(projection, _desired_items, [], _options, _now_ms),
    do: {:ok, projection, []}

  defp reconcile_changes(projection, desired_items, changes, options, now_ms) do
    limit = Map.fetch!(@limits, projection.stream)
    new_keys = Enum.count(changes, fn {key, _item} -> not Map.has_key?(projection.items, key) end)

    if map_size(projection.items) + new_keys > limit do
      rotate(projection, desired_items, options)
    else
      apply_changes(projection, changes, now_ms)
    end
  end

  defp apply_changes(projection, changes, now_ms) do
    Enum.reduce_while(changes, {:ok, projection, []}, fn {_key, item}, {:ok, current, frames} ->
      frame = projection_event(current.stream, current.projection_id, current.sequence + 1, item)

      case apply_event(current, frame, now_ms) do
        {:ok, next} -> {:cont, {:ok, next, [frame | frames]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> reverse_frames()
  end

  defp rotate(projection, desired_items, options) do
    with {:ok, replacement, frame} <- replace(projection.stream, desired_items, options),
         true <- replacement.projection_id != projection.projection_id do
      {:ok, replacement, [frame]}
    else
      false -> {:error, :projection_id_reused}
      {:error, reason} -> {:error, reason}
    end
  end

  defp reverse_frames({:ok, projection, frames}), do: {:ok, projection, Enum.reverse(frames)}
  defp reverse_frames(error), do: error

  defp snapshot_frame(stream, projection_id, items) do
    %{
      "type" => "projection_snapshot",
      "stream" => Atom.to_string(stream),
      "projection_id" => projection_id,
      "sequence" => 0,
      "items" => items
    }
  end

  defp projection_event(stream, projection_id, sequence, item) do
    %{
      "type" => "projection_event",
      "stream" => Atom.to_string(stream),
      "projection_id" => projection_id,
      "sequence" => sequence,
      "item" => item
    }
  end

  defp encoded_bound(value, limit) do
    if value |> JSON.encode!() |> byte_size() <= limit, do: :ok, else: {:error, :byte_limit}
  end

  defp event_error(projection, frame) do
    cond do
      frame["stream"] != Atom.to_string(projection.stream) -> {:error, :wrong_stream}
      frame["projection_id"] != projection.projection_id -> {:error, :stale_projection}
      true -> {:error, :stale_event}
    end
  end
end
