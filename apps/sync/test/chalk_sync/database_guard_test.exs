defmodule ChalkSync.DatabaseGuardTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias ChalkSync.Database

  test "a result passes through untouched" do
    assert Database.guard(fn -> {:ok, 1} end, :unavailable) == {:ok, 1}
  end

  test "a raise answers the unavailable result and leaves a log line" do
    log =
      capture_log(fn ->
        assert Database.guard(fn -> raise ArgumentError, "boom" end, :unavailable) == :unavailable
      end)

    assert log =~ "database work failed: ArgumentError"
  end

  test "an exit answers the unavailable result and leaves a log line" do
    log =
      capture_log(fn ->
        assert Database.guard(fn -> exit(:noproc) end, :unavailable) == :unavailable
      end)

    assert log =~ "database work exited: :noproc"
  end
end
