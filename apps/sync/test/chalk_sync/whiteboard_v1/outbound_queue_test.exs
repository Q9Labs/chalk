defmodule ChalkSync.WhiteboardV1.OutboundQueueTest do
  use ExUnit.Case, async: true

  alias ChalkSync.WhiteboardV1.OutboundQueue

  test "preserves order and rejects expired delivery" do
    assert {:ok, queue} = OutboundQueue.push(OutboundQueue.new(), %{"type" => "pong"}, 1_000)
    assert {:ok, %{"type" => "pong"}, queue} = OutboundQueue.pop(queue, 1_001)
    assert :empty = OutboundQueue.pop(queue, 1_002)

    assert {:ok, queue} = OutboundQueue.push(OutboundQueue.new(), %{"type" => "pong"}, 1_000)
    assert {:error, :expired} = OutboundQueue.pop(queue, 6_001)
  end

  test "caps queued frames" do
    queue =
      Enum.reduce(1..256, OutboundQueue.new(), fn _index, queue ->
        {:ok, next} = OutboundQueue.push(queue, %{"type" => "pong"}, 1_000)
        next
      end)

    assert {:error, :overloaded} = OutboundQueue.push(queue, %{"type" => "pong"}, 1_000)
  end
end
