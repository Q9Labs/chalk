defmodule ChalkSync.Live.Episode.Projections do
  @moduledoc """
  Presence and media projections of an Episode, and their reconciliation with the live set.
  """

  alias ChalkSync.Live.Projection
  alias ChalkSync.Stateholder

  @connection_qualities ["good", "weak", "poor"]

  defguard is_connection_quality(quality) when quality in @connection_qualities

  def presence_snapshot(state) do
    with {:ok, items} <- presence_items(state) do
      case reconcile_presence(state.presence_projection, items) do
        {:ok, projection, frames} -> {:ok, %{state | presence_projection: projection}, frames}
        {:error, reason} -> {:error, reason}
      end
    end
  end


  def replace_live_projections(state) do
    with {:ok, items} <- presence_items(state),
         {:ok, media_projection, media_frame} <- Projection.replace(:media, state.media_items),
         {:ok, presence_projection, presence_frame} <-
           Projection.replace(:presence, items) do
      next = %{
        state
        | media_projection: media_projection,
          presence_projection: presence_projection
      }

      {:ok, next, [media_frame, presence_frame]}
    end
  end


  defp reconcile_presence(projection, items) do
    ids = MapSet.new(items, & &1["participant_id"])

    departed =
      projection &&
        Enum.any?(Projection.items(projection), &(not MapSet.member?(ids, &1["participant_id"])))

    # Presence tombstones retain their old fields. Rotate on durable departure so
    # initial/recovery snapshots cannot resurrect a departed seat's association.
    if departed do
      case Projection.replace(:presence, items) do
        {:ok, next, frame} -> {:ok, next, [frame]}
        error -> error
      end
    else
      reconcile_projection(:presence, projection, items)
    end
  end


  def reconcile_projection(stream, nil, items) do
    case Projection.replace(stream, items) do
      {:ok, projection, frame} -> {:ok, projection, [frame]}
      {:error, reason} -> {:error, reason}
    end
  end

  def reconcile_projection(_stream, projection, items),
    do: Projection.reconcile(projection, items)


  defp presence_items(state) do
    case Stateholder.participant_devices(state.episode) do
      {:ok, seats} ->
        {:ok,
         Enum.map(seats, fn seat ->
           connected =
             Enum.any?(state.connections, fn {_socket, authority} ->
               authority.participant_id == seat.participant_id and
                 authority.generation == seat.generation
             end)

           %{
             "participant_id" => seat.participant_id,
             "state" => if(connected, do: "connected", else: "disconnected"),
             "speaking" => false,
             "active_speaker" => false,
             "admission_revision" => seat.admission_revision
           }
           |> put_known("identity_id", seat.identity_id)
           |> put_known("device_type", seat.device_type)
           |> put_known("connection_quality", seat_quality(state, seat))
         end)}

      {:retryable, reason} ->
        {:error, reason}
    end
  end


  # Two sockets of one seat can report different tiers; the guests see the worse one.
  defp seat_quality(state, seat) do
    state.connections
    |> Enum.filter(fn {_socket, authority} ->
      authority.participant_id == seat.participant_id and authority.generation == seat.generation
    end)
    |> Enum.map(fn {socket, _authority} -> Map.get(state.connection_qualities, socket) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.max_by(&Enum.find_index(@connection_qualities, fn tier -> tier == &1 end), fn ->
      nil
    end)
  end


  defp put_known(item, _key, nil), do: item
  defp put_known(item, key, value), do: Map.put(item, key, value)
end
