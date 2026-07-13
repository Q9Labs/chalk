defmodule ChalkSync.RecordingPlaneTest do
  use ExUnit.Case, async: true

  test "exposes start and stop controls that require stable operation ids" do
    assert Enum.sort(ChalkSync.RecordingPlane.behaviour_info(:callbacks)) ==
             [start_recording: 4, stop_recording: 4]
  end
end
