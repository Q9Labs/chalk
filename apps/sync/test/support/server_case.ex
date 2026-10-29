defmodule ChalkSync.ServerCase do
  @moduledoc "Boots a real Bandit listener on an ephemeral port for end-to-end tests."

  use ExUnit.CaseTemplate

  setup do
    pid =
      start_supervised!({Bandit, plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0})

    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    %{port: port}
  end
end
