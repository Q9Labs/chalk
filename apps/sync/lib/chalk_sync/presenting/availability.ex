defmodule ChalkSync.Presenting.Availability do
  @moduledoc """
  One runtime switch read per Sync node; presenting sockets only read its local cache.

  The API decides whether Presenting can be served and publishes that to `presenting_api_capability`.
  Sync offers Presenting only while the API says it is servable and the operator override allows it.
  The node default stands in only until an API release that publishes has started.
  """

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

  # Once the API has published, it alone decides what is servable and the override only narrows it, exactly as the
  # API reads it. Until then (or on a schema without the table) the override and the node default apply as before.
  @published_query """
  select coalesce(
    (select servable and coalesce((select enabled from presenting_settings where singleton), true)
       from presenting_api_capability where singleton),
    coalesce((select enabled from presenting_settings where singleton), $1))
  """
  @override_query "select coalesce((select enabled from presenting_settings where singleton), $1)"

  defp read_enabled(default) do
    Database.guard(
      fn ->
        case query(@published_query, default) do
          {:error, %Postgrex.Error{postgres: %{code: :undefined_table}}} ->
            case query(@override_query, default) do
              {:error, %Postgrex.Error{postgres: %{code: :undefined_table}}} -> default
              result -> enabled_or_false(result)
            end

          result ->
            enabled_or_false(result)
        end
      end,
      false
    )
  end

  defp query(sql, default) do
    Postgrex.query(Database.connection_for(:background), sql, [default],
      timeout: @query_timeout_ms
    )
  end

  defp enabled_or_false({:ok, %{rows: [[enabled]]}}), do: enabled
  defp enabled_or_false({:error, _reason}), do: false

  defp default_enabled?, do: Application.get_env(:chalk_sync, :presenting_default, false)
end
