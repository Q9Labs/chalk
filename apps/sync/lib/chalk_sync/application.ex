defmodule ChalkSync.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        {Registry, keys: :unique, name: ChalkSync.Rooms.Registry},
        {DynamicSupervisor, strategy: :one_for_one, name: ChalkSync.Rooms.Supervisor},
        {Registry, keys: :unique, name: ChalkSync.Sessions.Registry},
        {DynamicSupervisor, strategy: :one_for_one, name: ChalkSync.Sessions.Supervisor},
        {ChalkSync.Operations.Metrics, []},
        database_child(),
        stateholder_child(),
        observability_child(),
        {Task.Supervisor, name: ChalkSync.CommandTaskSupervisor},
        {ChalkSync.Sessions.CommandAdmission, []},
        {ChalkSync.Operations, []},
        fanout_child(),
        lifecycle_consumer_child(),
        external_operation_consumer_child(),
        retention_scheduler_child(),
        boot_check_child(),
        {ChalkSync.Operations.Readiness, []},
        dev_tools_child(),
        listener_child()
      ]
      |> Enum.reject(&is_nil/1)

    Supervisor.start_link(children, strategy: :one_for_one, name: ChalkSync.Supervisor)
  end

  @impl true
  def prep_stop(state) do
    _result = ChalkSync.Operations.begin_drain(3_000)
    state
  end

  defp stateholder_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Memory -> {ChalkSync.Stateholder.Memory, []}
      _adapter -> nil
    end
  end

  defp database_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres ->
        {ChalkSync.Database,
         url: Application.fetch_env!(:chalk_sync, :database_url),
         pool_size: Application.fetch_env!(:chalk_sync, :database_pool_size)}

      _adapter ->
        nil
    end
  end

  defp lifecycle_consumer_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres -> {ChalkSync.LifecycleConsumer, []}
      _adapter -> nil
    end
  end

  defp external_operation_consumer_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres ->
        {ChalkSync.ExternalOperationConsumer,
         adapter_timeout_ms:
           Application.fetch_env!(:chalk_sync, :external_operation_adapter_timeout_ms),
         poll_interval_ms:
           Application.fetch_env!(:chalk_sync, :external_operation_poll_interval_ms),
         media_plane: Application.get_env(:chalk_sync, :media_plane),
         recording_plane: Application.get_env(:chalk_sync, :recording_plane)}

      _adapter ->
        nil
    end
  end

  defp fanout_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres ->
        {ChalkSync.Fanout.PostgresNotifications,
         url: Application.fetch_env!(:chalk_sync, :database_url)}

      _adapter ->
        nil
    end
  end

  defp retention_scheduler_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres ->
        {ChalkSync.Retention.Scheduler,
         interval_ms: Application.fetch_env!(:chalk_sync, :retention_cleanup_interval_ms)}

      _adapter ->
        nil
    end
  end

  defp boot_check_child do
    if Application.fetch_env!(:chalk_sync, :enforce_production_boot_checks),
      do: {ChalkSync.Operations.BootCheck, []}
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
      :none ->
        nil

      port ->
        {Bandit,
         plug: ChalkSync.Transport.Router,
         ip: Application.fetch_env!(:chalk_sync, :listen_ip),
         port: port}
    end
  end
end
