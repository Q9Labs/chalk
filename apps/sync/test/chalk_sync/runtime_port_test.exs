defmodule ChalkSync.RuntimePortTest do
  use ExUnit.Case, async: false

  test "slot port applies to dev without replacing the ephemeral test listener" do
    previous = System.get_env("CHALK_SYNC_PORT")
    System.put_env("CHALK_SYNC_PORT", "21302")

    on_exit(fn ->
      case previous do
        nil -> System.delete_env("CHALK_SYNC_PORT")
        value -> System.put_env("CHALK_SYNC_PORT", value)
      end
    end)

    runtime = Path.expand("../../config/runtime.exs", __DIR__)
    assert Config.Reader.read!(runtime, env: :test) |> get_in([:chalk_sync, :port]) == nil
    assert Config.Reader.read!(runtime, env: :dev) |> get_in([:chalk_sync, :port]) == 21302
  end
end
