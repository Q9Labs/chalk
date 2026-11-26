defmodule ChalkSync.Presenting.Availability do
  @moduledoc "One runtime switch read per Sync node; presenting sockets only read its local cache."

  use GenServer

  alias ChalkSync.Database

  @poll_ms 1_000
  @query_timeout_ms 250
  @max_age_ms @poll_ms + 2 * @query_timeout_ms

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def enabled? do
    case :ets.whereis(__MODULE__) do
      :undefined ->
        not Application.fetch_env!(:chalk_sync, :database_workers) and default_enabled?()

      table ->
        case :ets.lookup(table, :enabled_until) do
          [{:enabled_until, until}] -> System.monotonic_time(:millisecond) < until
          [] -> false
        end
    end
  rescue
    ArgumentError -> false
  end

  @impl true
  def init(_opts) do
    :ets.new(__MODULE__, [:named_table, :protected, read_concurrency: true])
    {:ok, default_enabled?(), {:continue, :poll}}
  end

  @impl true
  def handle_continue(:poll, default), do: refresh(default)

  @impl true
  def handle_info(:poll, default), do: refresh(default)

  defp refresh(default) do
    if read_enabled(default) do
      :ets.insert(__MODULE__, {:enabled_until, System.monotonic_time(:millisecond) + @max_age_ms})
    else
      :ets.delete(__MODULE__, :enabled_until)
    end

    Process.send_after(self(), :poll, @poll_ms)
    {:noreply, default}
  end

  defp read_enabled(default) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection_for(:background),
               "select coalesce((select enabled from presenting_settings where singleton), $1)",
               [default],
               timeout: @query_timeout_ms
             ) do
          {:ok, %{rows: [[enabled]]}} -> enabled
          {:error, %Postgrex.Error{postgres: %{code: :undefined_table}}} -> default
          {:error, _reason} -> false
        end
      end,
      false
    )
  end

  defp default_enabled?, do: Application.get_env(:chalk_sync, :presenting_default, false)
end
