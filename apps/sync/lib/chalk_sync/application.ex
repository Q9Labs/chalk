defmodule ChalkSync.Application do
  @moduledoc false

  use Application

  alias ChalkSync.ProviderBridge.Config, as: ProviderBridgeConfig

  @impl true
  def start(_type, _args) do
    children =
      [
        %{id: :pg, start: {:pg, :start_link, []}},
        {Registry, keys: :unique, name: ChalkSync.Episodes.Registry},
        {DynamicSupervisor, strategy: :one_for_one, name: ChalkSync.Episodes.Supervisor},
        {ChalkSync.Operations.Metrics, []},
        diagnostics_supervisor_child(),
        database_child(),
        stateholder_child(),
        observability_child(),
        {Task.Supervisor, name: ChalkSync.CommandTaskSupervisor},
        {ChalkSync.Episodes.CommandIntake, []},
        {ChalkSync.Admission, []},
        collaboration_fanout_child(),
        {ChalkSync.Operations, []},
        fanout_child(),
        whiteboard_fanout_child(),
        lifecycle_consumer_child(),
        external_operation_consumer_child(),
        retention_scheduler_child(),
        boot_check_child(),
        {ChalkSync.Operations.Readiness, []},
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

  defp diagnostics_supervisor_child do
    case Application.fetch_env!(:chalk_sync, :episode_diagnostics) do
      %{mode: mode} = config when mode in [:localhost, :hosted] ->
        children = [
          {ChalkSync.Diagnostics.Buffer, []},
          {ChalkSync.Diagnostics.Deadlines, []},
          {ChalkSync.Diagnostics.Exporter, config: config}
        ]

        %{
          id: ChalkSync.Diagnostics.Supervisor,
          start: {Supervisor, :start_link, [children, [strategy: :rest_for_one]]}
        }

      _off ->
        nil
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
        adapter_timeout_ms =
          Application.fetch_env!(:chalk_sync, :external_operation_adapter_timeout_ms)

        {ChalkSync.ExternalOperationConsumer,
         adapter_timeout_ms: adapter_timeout_ms,
         poll_interval_ms:
           Application.fetch_env!(:chalk_sync, :external_operation_poll_interval_ms),
         media_plane: media_plane(adapter_timeout_ms),
         recording_plane: Application.get_env(:chalk_sync, :recording_plane)}

      _adapter ->
        nil
    end
  end

  defp media_plane(adapter_timeout_ms) do
    case Application.get_env(:chalk_sync, :provider_bridge) do
      nil -> Application.get_env(:chalk_sync, :media_plane)
      options -> ProviderBridgeConfig.install_media_plane!(options, adapter_timeout_ms)
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

  defp collaboration_fanout_child do
    transport =
      case Application.fetch_env!(:chalk_sync, :stateholder) do
        ChalkSync.Stateholder.Postgres ->
          {ChalkSync.Fanout.Collaboration.PostgresNotifications, nil}

        _adapter ->
          nil
      end

    {ChalkSync.Fanout.Collaboration, transport: transport}
  end

  defp whiteboard_fanout_child do
    case Application.fetch_env!(:chalk_sync, :stateholder) do
      ChalkSync.Stateholder.Postgres ->
        {ChalkSync.WhiteboardV1.Fanout,
         url: Application.fetch_env!(:chalk_sync, :database_url), source_id: instance_id()}

      _adapter ->
        nil
    end
  end

  defp instance_id do
    Application.get_env(:chalk_sync, :instance_id) ||
      Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)
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
