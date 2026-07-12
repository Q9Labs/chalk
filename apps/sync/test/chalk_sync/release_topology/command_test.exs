defmodule ChalkSync.ReleaseTopology.CommandTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ReleaseTopology.Command

  test "runs an executable directly and captures bounded output" do
    assert {:ok, %{exit_code: 0, output: "available", duration_ms: duration_ms}} =
             Command.run(%{"argv" => ["printf", "available"], "timeout_ms" => 1_000})

    assert is_integer(duration_ms)
    assert duration_ms >= 0
  end

  test "returns a safe error when the executable is unavailable" do
    assert {:error, %{reason: "command executable is unavailable"}} =
             Command.run(%{"argv" => ["chalk-command-does-not-exist"], "timeout_ms" => 1_000})
  end
end
