defmodule Mix.Tasks.Sync.BreakerTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Sync.Breaker

  test "rejects an empty scenario selection" do
    previous_port = Application.fetch_env!(:chalk_sync, :port)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :port, previous_port)
      Mix.Task.reenable("sync.breaker")
    end)

    Mix.Task.reenable("sync.breaker")

    assert_raise Mix.Error, "at least one sync.breaker scenario must be selected", fn ->
      Breaker.run(["--scenarios", ""])
    end
  end
end
