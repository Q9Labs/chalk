defmodule ChalkSync.WhiteboardV1.MultipartTest do
  use ExUnit.Case, async: true

  alias ChalkSync.WhiteboardV1.Multipart

  @operation_id "operation-0000000001"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "assembles all inbound parts before exposing one logical operation" do
    elements = Enum.map(0..128, &element/1)
    [first, second] = submit_parts(elements)

    assert {:incomplete, assembly} = Multipart.add(nil, second)
    assert {:incomplete, ^assembly} = Multipart.add(assembly, second)
    assert {:complete, operation} = Multipart.add(assembly, first)

    assert operation.operation_id == @operation_id
    assert operation.scene_id == @scene_id
    assert operation.sync_all
    assert Enum.map(operation.elements, & &1["id"]) == Enum.map(0..128, &"element-#{&1}")
  end

  test "partitions outbound updates by item and encoded-byte bounds" do
    elements = Enum.map(0..128, &element/1)

    assert {:ok, [first, second]} =
             Multipart.update_frames(%{
               "type" => "update",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "revision" => "7",
               "elements" => elements
             })

    assert first["type"] == "update_part"
    assert first["part"] == 0
    assert first["part_count"] == 2
    assert first["element_count"] == 129
    assert length(first["elements"]) == 128
    assert length(second["elements"]) == 1
    assert byte_size(JSON.encode!(first)) <= 262_144
    assert byte_size(JSON.encode!(second)) <= 262_144
  end

  test "partitions one-element pages when encoded bytes are the active bound" do
    elements =
      Enum.map(0..2, fn index ->
        put_in(element(index), ["payload", "content"], String.duplicate("x", 140_000))
      end)

    assert {:ok, frames} =
             Multipart.update_frames(%{
               "type" => "update",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "revision" => "8",
               "elements" => elements
             })

    assert length(frames) == 3
    assert Enum.all?(frames, &(length(&1["elements"]) == 1))
    assert Enum.all?(frames, &(byte_size(JSON.encode!(&1)) <= 262_144))
    assert Enum.flat_map(frames, & &1["elements"]) == elements
  end

  defp submit_parts(elements) do
    chunks = Enum.chunk_every(elements, 128)

    chunks
    |> Enum.with_index()
    |> Enum.map(fn {part_elements, part} ->
      %{
        operation_id: @operation_id,
        scene_id: @scene_id,
        sync_all: true,
        part: part,
        part_count: length(chunks),
        element_count: length(elements),
        elements: part_elements
      }
    end)
  end

  defp element(index) do
    %{
      "id" => "element-#{index}",
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => index,
      "index" => "a#{index}",
      "is_deleted" => false,
      "payload" => %{"x" => index, "y" => index}
    }
  end
end
