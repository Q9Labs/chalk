defmodule ChalkSync.Retention.Scheduler do
  @moduledoc """
  Runs bounded, independently verified retention cleanup batches.

  Cleanup failures remain observable and retry on the next fixed interval. They
  never crash the sync supervision tree or broaden a batch beyond the worker's
  database-enforced limits.
  """

  use GenServer

  alias ChalkSync.Database
  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Telemetry

  @default_interval_ms 1_000

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)

    if name do
      GenServer.start_link(__MODULE__, options, name: name)
    else
      GenServer.start_link(__MODULE__, options)
    end
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__) do
    GenServer.call(server, :health, 250)
  catch
    :exit, _reason -> %{status: "unavailable"}
  end

  @doc false
  def run_now(server \\ __MODULE__), do: GenServer.call(server, :run_now, 35_000)

  @impl GenServer
  def init(options) do
    interval_ms = Keyword.get(options, :interval_ms, @default_interval_ms)

    state = %{
      interval_ms: interval_ms,
      cleanup_fun: Keyword.get(options, :cleanup_fun, &cleanup_once/0),
      clock: Keyword.get(options, :clock, fn -> System.monotonic_time(:microsecond) end),
      last_success_at_ms: nil,
      consecutive_failures: 0,
      episodes: 0,
      event_rows: 0,
      receipt_rows: 0,
      lifecycle_intent_rows: 0,
      auto_run?: Keyword.get(options, :auto_run?, true),
      cleanup_pid: nil,
      cleanup_ref: nil,
      cleanup_started_at_us: nil,
      cleanup_waiters: []
    }

    if state.auto_run? do
      Process.send_after(self(), :cleanup, Keyword.get(options, :initial_delay_ms, interval_ms))
    end

    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state), do: {:reply, public_health(state), state}

  def handle_call(:run_now, from, state) do
    next = ensure_cleanup(state)
    {:noreply, %{next | cleanup_waiters: [from | next.cleanup_waiters]}}
  end

  @impl GenServer
  def handle_info(:cleanup, state) do
    {:noreply, ensure_cleanup(state)}
  end

  def handle_info({:cleanup_result, pid, result}, %{cleanup_pid: pid} = state) do
    {:noreply, finish_cleanup(state, result)}
  end

  def handle_info({:cleanup_result, _pid, _result}, state), do: {:noreply, state}

  def handle_info(
        {:DOWN, ref, :process, pid, reason},
        %{cleanup_pid: pid, cleanup_ref: ref} = state
      ) do
    {:noreply, finish_cleanup(state, {:error, {:cleanup_process_down, reason}})}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, %{cleanup_pid: pid, cleanup_ref: ref}) when is_pid(pid) do
    Process.demonitor(ref, [:flush])
    Process.exit(pid, :shutdown)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp ensure_cleanup(%{cleanup_pid: pid} = state) when is_pid(pid), do: state

  defp ensure_cleanup(state) do
    owner = self()
    cleanup_fun = state.cleanup_fun
    started_at_us = state.clock.()

    {pid, ref} =
      spawn_monitor(fn ->
        send(owner, {:cleanup_result, self(), cleanup_result(cleanup_fun)})
      end)

    %{state | cleanup_pid: pid, cleanup_ref: ref, cleanup_started_at_us: started_at_us}
  end

  defp cleanup_result(cleanup_fun) do
    cleanup_fun.()
  rescue
    exception ->
      {:error, {:cleanup_exception, exception.__struct__, postgres_error_reason(exception)}}
  catch
    kind, reason -> {:error, {:cleanup_exit, kind, reason}}
  end

  defp finish_cleanup(state, result) do
    Process.demonitor(state.cleanup_ref, [:flush])
    duration_us = max(state.clock.() - state.cleanup_started_at_us, 0)
    next = %{state | cleanup_pid: nil, cleanup_ref: nil, cleanup_started_at_us: nil}
    {reply, next} = apply_cleanup(next, result, duration_us)
    Enum.each(next.cleanup_waiters, &GenServer.reply(&1, reply))
    next = %{next | cleanup_waiters: []}

    if next.auto_run?, do: Process.send_after(self(), :cleanup, next.interval_ms)
    next
  end

  defp apply_cleanup(state, result, duration_us) do
    case result do
      {:ok, cleanup} ->
        deleted_bytes =
          cleanup.event_bytes + cleanup.receipt_bytes + cleanup.lifecycle_intent_bytes

        Telemetry.execute(
          [:retention, :cleanup],
          %{duration_us: duration_us, bytes: deleted_bytes},
          %{outcome: :success}
        )

        next = %{
          state
          | last_success_at_ms: System.monotonic_time(:millisecond),
            consecutive_failures: 0,
            episodes: state.episodes + cleanup.episodes,
            event_rows: state.event_rows + cleanup.event_rows,
            receipt_rows: state.receipt_rows + cleanup.receipt_rows,
            lifecycle_intent_rows: state.lifecycle_intent_rows + cleanup.lifecycle_intent_rows
        }

        {result, next}

      {:error, reason} ->
        Telemetry.execute(
          [:retention, :cleanup],
          %{duration_us: duration_us},
          Map.merge(%{outcome: :failure}, failure_metadata(reason))
        )

        {result, %{state | consecutive_failures: state.consecutive_failures + 1}}
    end
  end

  defp failure_metadata({:error, reason}), do: failure_metadata(reason)

  defp failure_metadata({:cleanup_exception, error_class, error_reason}) do
    %{error_class: error_class, error_reason: error_reason}
  end

  defp failure_metadata({:cleanup_exit, kind, reason}) do
    %{error_class: kind, error_reason: normalize_error_reason(reason)}
  end

  defp failure_metadata({:cleanup_process_down, reason}) do
    %{error_class: :cleanup_process_down, error_reason: normalize_error_reason(reason)}
  end

  defp failure_metadata(%{postgres: %{code: code}}) when is_atom(code) do
    %{error_class: :postgres, error_reason: code}
  end

  defp failure_metadata(%{__struct__: error_class}) when is_atom(error_class) do
    %{error_class: error_class, error_reason: :exception}
  end

  defp failure_metadata({error_class, reason}) when is_atom(error_class) do
    %{error_class: error_class, error_reason: normalize_error_reason(reason)}
  end

  defp failure_metadata(reason) do
    %{error_class: :cleanup, error_reason: normalize_error_reason(reason)}
  end

  defp postgres_error_reason(%{postgres: %{code: code}}) when is_atom(code), do: code
  defp postgres_error_reason(_exception), do: :exception

  defp normalize_error_reason(reason) when is_atom(reason), do: reason
  defp normalize_error_reason(reason) when is_binary(reason), do: :binary_reason
  defp normalize_error_reason(reason) when is_integer(reason), do: :integer_reason
  defp normalize_error_reason(reason) when is_float(reason), do: :float_reason
  defp normalize_error_reason(reason) when is_list(reason), do: :list_reason
  defp normalize_error_reason(reason) when is_map(reason), do: :map_reason
  defp normalize_error_reason(reason) when is_tuple(reason), do: :tuple_reason
  defp normalize_error_reason(_reason), do: :unknown_reason

  defp cleanup_once do
    episode = %EpisodeKey{tenant_id: "retention", space_id: "retention", episode_id: "retention"}
    CleanupWorker.run_once(Database.connection(episode))
  end

  defp public_health(state) do
    %{
      status: if(state.consecutive_failures == 0, do: "ok", else: "degraded"),
      consecutive_failures: state.consecutive_failures,
      last_success_age_ms: age_ms(state.last_success_at_ms),
      cleaned_episodes: state.episodes,
      deleted_event_rows: state.event_rows,
      deleted_receipt_rows: state.receipt_rows,
      deleted_lifecycle_intent_rows: state.lifecycle_intent_rows
    }
  end

  defp age_ms(nil), do: nil

  defp age_ms(timestamp),
    do: max(System.monotonic_time(:millisecond) - timestamp, 0)
end
