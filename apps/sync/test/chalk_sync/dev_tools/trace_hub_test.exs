defmodule ChalkSync.DevTools.TraceHubTest do
  use ExUnit.Case, async: true

  alias ChalkSync.DevTools.TraceHub

  test "subscribers receive bounded, structured trace events" do
    action = "test_#{System.unique_integer([:positive])}"

    assert :ok = TraceHub.subscribe()
    assert_receive {:trace_history, events}
    assert is_list(events)

    assert :ok = TraceHub.record("test", action, %{"safe" => true})

    assert_receive {:trace_event,
                    %{
                      "id" => id,
                      "timestamp" => timestamp,
                      "source" => "test",
                      "action" => ^action,
                      "details" => %{"safe" => true}
                    }}

    assert is_integer(id)
    assert is_integer(timestamp)
  end
end
