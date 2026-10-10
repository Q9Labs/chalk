defmodule ChalkSync.Transport.SocketCloseTest do
  use ExUnit.Case, async: false
  alias ChalkSync.Transport.SocketV1
  alias ChalkSync.Transport.SocketWhiteboardV1

  setup do
    handler = "alert-closures-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:closed, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
  end

  test "thirteen people leaving both sockets do not count as failures" do
    for _participant <- 1..13, socket <- [SocketV1, SocketWhiteboardV1] do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate(:remote, state)
      assert_received {:closed, %{reason: :client_closed, close_kind: :normal}}
    end

    refute_received {:closed, %{close_kind: :abnormal}}
  end

  test "twelve abrupt drops cross the ten-failure threshold, while drains do not" do
    for socket <- [SocketV1, SocketWhiteboardV1], _connection <- 1..6 do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate({:error, :closed}, state)
      assert_received {:closed, %{reason: :transport_error, close_kind: :abnormal}}
    end

    for socket <- [SocketV1, SocketWhiteboardV1] do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate(:shutdown, state)
      assert_received {:closed, %{reason: :server_shutdown, close_kind: :drain}}
    end
  end

  test "heartbeat timeout remains abnormal when WebSock calls terminate normally" do
    assert {:ok, initial} = SocketV1.init(%{})
    state = %{initial | phase: :live, missed_heartbeats: 1}

    assert {:stop, :normal, {1001, "heartbeat timeout"}, stopped} =
             SocketV1.handle_info(:heartbeat_check, state)

    assert :ok = SocketV1.terminate(:normal, stopped)
    assert_received {:closed, %{reason: :timeout, close_code: 1001, close_kind: :abnormal}}
  end

  test "acknowledging a class end is normal" do
    assert ChalkSync.Transport.SocketClose.attributes(:normal, %{
             reason: :normal,
             close_code: 1000
           }) ==
             %{reason: :normal, close_code: 1000, close_kind: :normal}
  end
end
