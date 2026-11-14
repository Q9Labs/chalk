defmodule ChalkSync.Operations.Probe.Workers do
  @moduledoc """
  Health of the lifecycle consumer and external-operation worker processes.
  """

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.LifecycleConsumer
  alias ChalkSync.Operations.Probe.Report
  alias ChalkSync.Retention.Scheduler, as: RetentionScheduler

  @external_operation_staleness_ceiling_ms 30_000
  @external_operation_staleness_floor_ms 2_000

  def process_observations(boot?) do
    with :ok <- observe_process(ChalkSync.Episodes.Supervisor),
         :ok <- observe_process(ChalkSync.CommandTaskSupervisor),
         :ok <- observe_process(ChalkSync.Episodes.CommandIntake),
         :ok <- observe_process(PostgresNotifications),
         :ok <- observe_process(LifecycleConsumer),
         :ok <- observe_process(RetentionScheduler),
         {:ok, fanout} <-
           Report.observe(PostgresNotifications, fn -> safe_health(PostgresNotifications) end),
         {:ok, lifecycle} <-
           Report.observe(LifecycleConsumer, fn -> safe_health(LifecycleConsumer) end),
         {:ok, external_operation_failures} <- observe_external_operation_lanes(boot?),
         {:ok, retention} <-
           Report.observe(RetentionScheduler, fn -> safe_health(RetentionScheduler) end),
         :ok <-
           Report.observe(
             :lifecycle_consumer,
             fn -> validate_lifecycle_health(lifecycle, boot?) end,
             consumer_measurements(lifecycle)
           ) do
      {:ok,
       %{
         coordinator_supervisor: "ok",
         command_intake: "ok",
         notification_listener: "ok",
         notification_count: fanout.received_count,
         lifecycle_consumer: "ok",
         lifecycle_consecutive_failures: lifecycle.consecutive_failures,
         external_operation_consumer: "ok",
         external_operation_consumer_consecutive_failures: external_operation_failures,
         retention_cleanup: retention.status,
         retention_cleanup_consecutive_failures: retention.consecutive_failures
       }}
    else
      _error -> {:error, :required_process_unavailable}
    end
  end

  defp validate_lifecycle_health(_health, true), do: :ok

  defp validate_lifecycle_health(health, false) do
    now = System.monotonic_time(:millisecond)

    cond do
      health.consecutive_failures >= 2 -> {:error, :lifecycle_consumer_unavailable}
      is_nil(health.last_success_at_ms) -> {:error, :lifecycle_consumer_initializing}
      now - health.last_success_at_ms > 2_000 -> {:error, :lifecycle_consumer_stale}
      true -> :ok
    end
  end

  @doc false
  def validate_external_operation_health(_health, true), do: :ok

  def validate_external_operation_health(health, false) do
    now = System.monotonic_time(:millisecond)

    cond do
      health.consecutive_failures >= 2 ->
        {:error, :external_operation_consumer_unavailable}

      is_nil(health.last_success_at_ms) ->
        {:error, :external_operation_consumer_initializing}

      overdue_external_operation_work?(health) ->
        {:error, :external_operation_consumer_stale}

      external_operation_stale?(health, now) and active_external_operation_work?(health) ->
        :ok

      external_operation_stale?(health, now) ->
        {:error, :external_operation_consumer_stale}

      true ->
        :ok
    end
  end

  defp overdue_external_operation_work?(health) do
    active_work_age_ms = Map.get(health, :active_work_age_ms)
    active_work_timeout_ms = Map.get(health, :active_work_timeout_ms)

    Map.get(health, :active_work, false) and is_integer(active_work_age_ms) and
      is_integer(active_work_timeout_ms) and active_work_timeout_ms > 0 and
      active_work_age_ms > active_work_timeout_ms
  end

  defp external_operation_stale?(health, now) do
    now - health.last_success_at_ms > external_operation_staleness_timeout_ms()
  end

  defp active_external_operation_work?(health) do
    active_work_age_ms = Map.get(health, :active_work_age_ms)
    active_work_timeout_ms = Map.get(health, :active_work_timeout_ms)

    Map.get(health, :active_work, false) and is_integer(active_work_age_ms) and
      is_integer(active_work_timeout_ms) and active_work_timeout_ms > 0 and
      active_work_age_ms <= active_work_timeout_ms
  end

  @doc false
  def external_operation_staleness_timeout_ms do
    poll_interval_ms =
      Application.fetch_env!(:chalk_sync, :external_operation_poll_interval_ms)

    poll_interval_ms
    |> Kernel.*(3)
    |> max(@external_operation_staleness_floor_ms)
    |> min(@external_operation_staleness_ceiling_ms)
  end

  defp safe_health(PostgresNotifications) do
    {:ok, PostgresNotifications.health()}
  catch
    :exit, _reason -> {:error, :notification_listener_unavailable}
  end

  defp safe_health(LifecycleConsumer) do
    {:ok, LifecycleConsumer.health()}
  catch
    :exit, _reason -> {:error, :lifecycle_consumer_unavailable}
  end

  defp safe_health(RetentionScheduler) do
    {:ok, RetentionScheduler.health()}
  catch
    :exit, _reason -> {:error, :retention_cleanup_unavailable}
  end

  @doc false
  def observe_external_operation_lanes(boot?) do
    Enum.reduce_while(ExternalOperationConsumer.lane_names(), {:ok, 0}, fn {lane, name},
                                                                           {:ok, failures} ->
      case observe_external_operation_lane(lane, name, boot?) do
        {:ok, health} -> {:cont, {:ok, max(failures, health.consecutive_failures)}}
        error -> {:halt, error}
      end
    end)
  end

  defp observe_external_operation_lane(lane, name, boot?) do
    with :ok <- observe_process(name),
         {:ok, health} <- Report.observe(name, fn -> safe_external_operation_health(name) end),
         :ok <-
           Report.observe(
             external_operation_check(lane),
             fn -> validate_external_operation_health(health, boot?) end,
             consumer_measurements(health)
           ) do
      {:ok, health}
    end
  end

  defp external_operation_check(:local), do: :external_operation_consumer_local
  defp external_operation_check(:provider), do: :external_operation_consumer_provider

  defp safe_external_operation_health(name) do
    {:ok, ExternalOperationConsumer.health(name)}
  catch
    :exit, _reason -> {:error, :external_operation_consumer_unavailable}
  end

  defp observe_process(name) do
    Report.observe(name, fn ->
      if is_pid(Process.whereis(name)), do: :ok, else: {:error, :required_process_unavailable}
    end)
  end

  defp consumer_measurements(health) do
    health
    |> Map.take([
      :consecutive_failures,
      :active_work,
      :active_work_age_ms,
      :active_work_timeout_ms
    ])
    |> Map.put(
      :last_success_age_ms,
      if(is_nil(health.last_success_at_ms),
        do: "never",
        else: System.monotonic_time(:millisecond) - health.last_success_at_ms
      )
    )
    |> Map.reject(fn {_key, value} -> is_nil(value) end)
  end
end
