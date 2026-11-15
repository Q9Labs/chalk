defmodule ChalkSync.Operations.BootCheck do
  @moduledoc false

  use GenServer

  alias ChalkSync.Operations
  alias ChalkSync.Operations.Probe

  # An absent or switching database is an outage that readiness reports and recovers from, not a
  # bad deploy. Crashing on it let systemd's start limit strand Sync for hours. The checks that
  # need the database then run again until they pass, and sockets stay out until they do. The
  # provider bridge is the API, and the API waits for the same database at start, so a bridge that
  # is not ready yet is part of the same outage.
  @outage_reasons [
    :database_unavailable,
    :database_not_writable_primary,
    :provider_bridge_unavailable
  ]
  @recheck_ms 5_000

  def start_link(options \\ []), do: GenServer.start_link(__MODULE__, options)

  @impl GenServer
  def init(_options), do: check()

  @impl GenServer
  def handle_info(:recheck, state) do
    case check() do
      {:ok, next} -> {:noreply, next}
      {:stop, reason} -> {:stop, reason, state}
    end
  end

  defp check do
    case Probe.run(boot?: true) do
      {:ok, observations} -> passed(observations)
      {:error, reason, _observations} -> refuse_unless_outage(reason)
      {:error, reason} -> refuse_unless_outage(reason)
    end
  end

  defp passed(observations) do
    Operations.boot_check_passed()
    {:ok, observations}
  end

  defp refuse_unless_outage(reason) when reason in @outage_reasons do
    Operations.hold_for_boot_check()
    Process.send_after(self(), :recheck, @recheck_ms)
    {:ok, %{outage: reason}}
  end

  defp refuse_unless_outage(reason), do: {:stop, {:production_boot_check_failed, reason}}
end
