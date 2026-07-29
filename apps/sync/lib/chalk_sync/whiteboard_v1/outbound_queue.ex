defmodule ChalkSync.WhiteboardV1.OutboundQueue do
  @moduledoc "Bounded per-socket queue for whiteboard-v1 delivery."

  alias ChalkSync.Contract.GeneratedWhiteboardV1

  @limits GeneratedWhiteboardV1.limits()
  @max_frames @limits["socketQueueMaxFrames"]
  @max_bytes @limits["socketQueueMaxBytes"]
  @max_age_ms @limits["socketQueueMaxAgeMs"]

  defstruct entries: :queue.new(), frame_count: 0, byte_count: 0

  @type t :: %__MODULE__{}

  def new, do: %__MODULE__{}

  def push(%__MODULE__{} = queue, frame, now_ms) do
    encoded = JSON.encode!(frame)
    bytes = byte_size(encoded)

    if queue.frame_count + 1 > @max_frames or queue.byte_count + bytes > @max_bytes do
      {:error, :overloaded}
    else
      {:ok,
       %{
         queue
         | entries: :queue.in({frame, bytes, now_ms}, queue.entries),
           frame_count: queue.frame_count + 1,
           byte_count: queue.byte_count + bytes
       }}
    end
  end

  def pop(%__MODULE__{} = queue, now_ms) do
    case :queue.out(queue.entries) do
      {:empty, _entries} ->
        :empty

      {{:value, {_frame, _bytes, inserted_at}}, _entries}
      when now_ms - inserted_at > @max_age_ms ->
        {:error, :expired}

      {{:value, {frame, bytes, _inserted_at}}, entries} ->
        {:ok, frame,
         %{
           queue
           | entries: entries,
             frame_count: queue.frame_count - 1,
             byte_count: queue.byte_count - bytes
         }}
    end
  end
end
