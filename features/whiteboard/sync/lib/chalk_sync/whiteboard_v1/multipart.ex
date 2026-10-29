defmodule ChalkSync.WhiteboardV1.Multipart do
  @moduledoc "Bounded atomic assembly and framing for multipart whiteboard-v1 updates."

  alias ChalkSync.Contract.GeneratedWhiteboardV1

  @limits GeneratedWhiteboardV1.limits()
  @max_parts @limits["multipartUpdateMaxParts"]
  @max_items @limits["multipartUpdateMaxItems"]
  @max_bytes @limits["multipartUpdateMaxBytes"]
  @frame_items @limits["elementBatchMaxItems"]
  @outbound_frame_bytes @limits["encodedOutboundFrameBytes"]

  def add(nil, part) do
    part
    |> new_assembly()
    |> add_part(part)
  end

  def add(assembly, part), do: add_part(assembly, part)

  def update_frames(update) do
    if valid_single_update?(update) do
      {:ok, [update]}
    else
      with {:ok, chunks} <- partition_elements(update),
           true <- length(chunks) >= 2 and length(chunks) <= @max_parts,
           frames = multipart_frames(update, chunks),
           true <- encoded_bytes(frames) <= @max_bytes do
        {:ok, frames}
      else
        _ -> {:error, :invalid_payload}
      end
    end
  end

  defp new_assembly(part) do
    %{
      operation_id: part.operation_id,
      scene_id: part.scene_id,
      sync_all: part.sync_all,
      part_count: part.part_count,
      element_count: part.element_count,
      parts: %{},
      bytes: 0
    }
  end

  defp add_part(assembly, part) do
    with :ok <- consistent?(assembly, part),
         {:ok, next} <- put_part(assembly, part),
         true <- next.bytes <= @max_bytes do
      if map_size(next.parts) == next.part_count,
        do: complete(next),
        else: {:incomplete, next}
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp consistent?(assembly, part) do
    if assembly.operation_id == part.operation_id and
         assembly.scene_id == part.scene_id and
         assembly.sync_all == part.sync_all and
         assembly.part_count == part.part_count and
         assembly.element_count == part.element_count,
       do: :ok,
       else: {:error, :invalid_payload}
  end

  defp put_part(assembly, part) do
    case Map.fetch(assembly.parts, part.part) do
      :error ->
        {:ok,
         %{
           assembly
           | parts: Map.put(assembly.parts, part.part, part.elements),
             bytes: assembly.bytes + encoded_bytes(part)
         }}

      {:ok, elements} when elements == part.elements ->
        {:ok, assembly}

      {:ok, _elements} ->
        {:error, :invalid_payload}
    end
  end

  defp complete(assembly) do
    elements =
      0..(assembly.part_count - 1)
      |> Enum.flat_map(&Map.get(assembly.parts, &1, []))

    if length(elements) == assembly.element_count and length(elements) <= @max_items do
      {:complete,
       %{
         operation_id: assembly.operation_id,
         scene_id: assembly.scene_id,
         sync_all: assembly.sync_all,
         elements: elements
       }}
    else
      {:error, :invalid_payload}
    end
  end

  defp valid_single_update?(update) do
    length(update["elements"]) <= @frame_items and
      encoded_bytes(update) <= @outbound_frame_bytes
  end

  defp partition_elements(update) do
    result =
      Enum.reduce_while(update["elements"], {:ok, [], []}, fn element,
                                                              {:ok, completed, current} ->
        candidate = current ++ [element]

        cond do
          fits_outbound_part?(update, candidate) ->
            {:cont, {:ok, completed, candidate}}

          current != [] and fits_outbound_part?(update, [element]) ->
            {:cont, {:ok, [current | completed], [element]}}

          true ->
            {:halt, {:error, :invalid_payload}}
        end
      end)

    case result do
      {:ok, completed, current} when current != [] ->
        {:ok, Enum.reverse([current | completed])}

      _ ->
        {:error, :invalid_payload}
    end
  end

  defp fits_outbound_part?(update, elements) do
    length(elements) <= @frame_items and
      encoded_bytes(%{
        "type" => "update_part",
        "operation_id" => update["operation_id"],
        "scene_id" => update["scene_id"],
        "revision" => update["revision"],
        "part" => @max_parts - 1,
        "part_count" => @max_parts,
        "element_count" => length(update["elements"]),
        "elements" => elements
      }) <= @outbound_frame_bytes
  end

  defp multipart_frames(update, chunks) do
    count = length(chunks)
    element_count = length(update["elements"])

    chunks
    |> Enum.with_index()
    |> Enum.map(fn {elements, part} ->
      %{
        "type" => "update_part",
        "operation_id" => update["operation_id"],
        "scene_id" => update["scene_id"],
        "revision" => update["revision"],
        "part" => part,
        "part_count" => count,
        "element_count" => element_count,
        "elements" => elements
      }
    end)
  end

  defp encoded_bytes(value), do: value |> JSON.encode!() |> byte_size()
end
