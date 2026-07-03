defmodule ChalkSync.ServerCase do
  @moduledoc """
  Boots a real Bandit listener on an ephemeral port for end-to-end tests.
  Tests stay `async: true` by using unique room ids instead of resetting the
  shared stateholder.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import ChalkSync.ServerCase, only: [unique_room_id: 0]
    end
  end

  setup do
    pid = start_supervised!({Bandit, plug: ChalkSync.Transport.Router, port: 0})
    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    %{port: port}
  end

  def unique_room_id, do: "room-#{System.unique_integer([:positive])}"
end
