defmodule ChalkSync.TestProcessTest do
  use ExUnit.Case, async: true

  alias ChalkSync.TestProcess

  test "stops a live server and can stop it again" do
    {:ok, server} = Agent.start(fn -> nil end)
    monitor = Process.monitor(server)

    assert :ok = TestProcess.stop(server)
    assert_receive {:DOWN, ^monitor, :process, ^server, :normal}
    assert :ok = TestProcess.stop(server)
  end

  test "tolerates exit after a successful liveness observation" do
    server = spawn(fn -> receive do: (:finish -> :ok) end)
    monitor = Process.monitor(server)
    assert Process.alive?(server)

    send(server, :finish)
    assert_receive {:DOWN, ^monitor, :process, ^server, :normal}

    # This is the interleaving between the old alive? check and GenServer.stop.
    assert :ok = TestProcess.stop(server)
  end

  test "tolerates an absent registered server" do
    assert :ok = TestProcess.stop(:absent_test_teardown_server)
  end

  test "does not hide unexpected stop failures" do
    assert catch_exit(TestProcess.stop(self())) ==
             {:calling_self, {GenServer, :stop, [self(), :normal, :infinity]}}
  end
end
