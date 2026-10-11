defmodule ChalkSync.TestProcess do
  @moduledoc """
  Stops test-owned servers even when their owner has already exited.

  Checking liveness before stopping is racy: linked connections can exit between
  the check and the stop. Only an absent process is an expected teardown outcome;
  other stop failures must still fail the test.
  """

  def stop(server) do
    GenServer.stop(server)
  catch
    :exit, {:noproc, _details} -> :ok
    :exit, :noproc -> :ok
  end
end
