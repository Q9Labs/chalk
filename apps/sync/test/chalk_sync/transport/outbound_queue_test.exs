defmodule ChalkSync.Transport.OutboundQueueTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Transport.OutboundQueue

  test "retains transport in-flight reservations until a matching cumulative ACK" do
    queue = queue_at(0)

    for revision <- 1..256 do
      assert :ok =
               OutboundQueue.push(queue, "x",
                 revision: revision,
                 state_digest: "digest-#{revision}"
               )

      assert {:ok, %{revision: ^revision}} = OutboundQueue.pop(queue)
    end

    assert :empty = OutboundQueue.pop(queue)
    assert {:error, {:overflow, :event_limit}} = OutboundQueue.push(queue, "overflow")
  end

  defp queue_at(now) do
    {queue, _clock} = queue_with_clock(now)
    queue
  end

  defp queue_with_clock(now) do
    clock = :atomics.new(1, [])
    :atomics.put(clock, 1, now)
    {OutboundQueue.new(clock: fn -> :atomics.get(clock, 1) end), clock}
  end
end
