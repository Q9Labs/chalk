defmodule ChalkSync.Operations.BootCheck do
  @moduledoc false

  use GenServer

  alias ChalkSync.Operations.Probe

  def start_link(options \\ []), do: GenServer.start_link(__MODULE__, options)

  @impl GenServer
  def init(_options) do
    case Probe.run(boot?: true) do
      {:ok, observations} -> {:ok, observations}
      {:error, reason} -> {:stop, {:production_boot_check_failed, reason}}
    end
  end
end
