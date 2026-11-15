defmodule ChalkSync.Operations.BootCheck do
  @moduledoc false

  use GenServer

  alias ChalkSync.Operations.Probe

  # An absent or switching database is an outage that readiness reports and recovers from, not a
  # bad deploy. Crashing on it let systemd's start limit strand Sync for hours.
  @outage_reasons [:database_unavailable, :database_not_writable_primary]

  def start_link(options \\ []), do: GenServer.start_link(__MODULE__, options)

  @impl GenServer
  def init(_options) do
    case Probe.run(boot?: true) do
      {:ok, observations} -> {:ok, observations}
      {:error, reason, _observations} -> refuse_unless_outage(reason)
      {:error, reason} -> refuse_unless_outage(reason)
    end
  end

  defp refuse_unless_outage(reason) when reason in @outage_reasons, do: {:ok, %{outage: reason}}
  defp refuse_unless_outage(reason), do: {:stop, {:production_boot_check_failed, reason}}
end
