defmodule ChalkSync.WhiteboardV1.ProtocolTest do
  use ExUnit.Case, async: true

  alias ChalkSync.WhiteboardV1.Protocol

  @operation_id "operation-0000000001"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "decodes a strict explicit clear and rejects unknown fields" do
    assert {:ok, {:clear, %{operation_id: @operation_id, scene_id: @scene_id}}} =
             Protocol.decode(
               JSON.encode!(%{
                 "type" => "clear",
                 "operation_id" => @operation_id,
                 "scene_id" => @scene_id
               })
             )

    assert {:error, :invalid_payload} =
             Protocol.decode(
               JSON.encode!(%{
                 "type" => "clear",
                 "operation_id" => @operation_id,
                 "scene_id" => @scene_id,
                 "unknown" => true
               })
             )
  end

  test "encodes only strict bounded server frames" do
    assert JSON.decode!(Protocol.pong()) == %{"type" => "pong"}

    assert_raise ArgumentError, fn ->
      Protocol.encode!(%{"type" => "pong", "unknown" => true})
    end
  end
end
