defmodule ChalkSync.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        {Registry, keys: :unique, name: ChalkSync.Rooms.Registry},
        {DynamicSupervisor, strategy: :one_for_one, name: ChalkSync.Rooms.Supervisor},
        stateholder_child(),
        observability_child(),
        dev_tools_child(),
        listener_child()
      ]
      |> Enum.reject(&is_nil/1)

    Supervisor.start_link(children, strategy: :one_for_one, name: ChalkSync.Supervisor)
  end

  defp stateholder_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Memory -> {ChalkSync.Stateholder.Memory, []}
      _adapter -> nil
    end
  end

  defp dev_tools_child do
    if Application.fetch_env!(:chalk_sync, :dev_tools),
      do: {ChalkSync.DevTools.TraceHub, []}
  end

  defp observability_child do
    if ChalkSync.Observability.enabled?(), do: ChalkSync.Observability
  end

  # Tests set port: :none and boot their own listener on an ephemeral port.
  defp listener_child do
    case Application.fetch_env!(:chalk_sync, :port) do
      :none -> nil
      port -> {Bandit, plug: ChalkSync.Transport.Router, port: port}
    end
  end
end
