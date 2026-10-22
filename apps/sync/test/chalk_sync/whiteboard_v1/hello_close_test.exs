defmodule ChalkSync.WhiteboardV1.HelloCloseTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Transport.SocketWhiteboardV1

  # The hello the client sends first. Clients step their hello down only on 1009.
  @client_hello %{
    "type" => "hello",
    "protocol" => "whiteboard-v1",
    "token" => String.duplicate("t", 32),
    "cursor" => nil,
    "extensions" => [
      %{"name" => "presentation_v1"},
      %{"name" => "view_v1", "origins" => true},
      %{"name" => "draw_policy_v1"}
    ]
  }

  test "a rejected token closes 1008, so the client keeps its hello" do
    assert {:stop, :normal, {1008, "invalid token"}, _state} = hello(@client_hello)
  end

  test "an extension Sync does not know closes 1009, so the client steps its hello down" do
    future = Map.update!(@client_hello, "extensions", &(&1 ++ [%{"name" => "future_v1"}]))
    assert {:stop, :normal, {1009, _reason}, _state} = hello(future)
  end

  defp hello(frame) do
    {:ok, state} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(state.hello_timer)
    SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, state)
  end
end
