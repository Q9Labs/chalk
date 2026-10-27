defmodule ChalkSync.Operations.Probe do
  @moduledoc false

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.LifecycleConsumer
  alias ChalkSync.Observability
  alias ChalkSync.ProviderBridge.Client, as: ProviderBridgeClient
  alias ChalkSync.ProviderBridge.Config, as: ProviderBridgeConfig
  alias ChalkSync.Retention.Scheduler, as: RetentionScheduler
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  @query_timeout_ms 1_000
  @lifecycle_lag_limit_ms 30_000
  @external_operation_staleness_floor_ms 2_000
  @external_operation_staleness_ceiling_ms 30_000

  @spec run(keyword()) :: {:ok, map()} | {:error, atom()} | {:error, atom(), map()}
  def run(options \\ []) do
    boot? = Keyword.get(options, :boot?, false)

    with :ok <- observe(:production_modules, &production_modules/0),
         {:ok, provider_bridge} <- observe(:provider_bridge, &provider_bridge_observation/0),
         {:ok, database, oldest_due} <- observe(:database, &database_observations/0),
         :ok <- validate_observed_database(database, oldest_due),
         {:ok, processes} <- process_observations(boot?) do
      {:ok, %{database: database, processes: processes, provider_bridge: provider_bridge}}
    end
  rescue
    _exception ->
      log_failure(:probe, :probe_failed, %{observed: "exception"})
      {:error, :probe_failed}
  catch
    :exit, _reason ->
      log_failure(:probe, :probe_failed, %{observed: "exit"})
      {:error, :probe_failed}
  end

  defp production_modules do
    adapter = Application.fetch_env!(:chalk_sync, :stateholder)
    verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    require_auth? = Application.get_env(:chalk_sync, :require_production_auth, false)

    with :ok <- validate_production_modules(adapter, verifier, require_auth?) do
      validate_provider_bridge_config(require_auth?)
    end
  end

  defp validate_production_modules(adapter, verifier, require_auth?) do
    cond do
      adapter != ChalkSync.Stateholder.Postgres ->
        {:error, :non_production_stateholder}

      require_auth? and verifier == ChalkSync.Auth.DevTokenVerifier ->
        {:error, :development_token_verifier}

      require_auth? and
          (not Code.ensure_loaded?(verifier) or not function_exported?(verifier, :verify, 1)) ->
        {:error, :invalid_token_verifier}

      true ->
        :ok
    end
  end

  defp validate_provider_bridge_config(false), do: :ok

  defp validate_provider_bridge_config(true) do
    if Application.get_env(:chalk_sync, :provider_bridge),
      do: :ok,
      else: {:error, :provider_bridge_not_configured}
  end

  defp provider_bridge_observation do
    case Application.get_env(:chalk_sync, :provider_bridge) do
      nil ->
        {:ok, %{status: "disabled"}}

      options ->
        client = ProviderBridgeConfig.client!(options, 1_000)

        case ProviderBridgeClient.ready(client) do
          :ok -> {:ok, %{status: "ready"}}
          {:error, _reason} -> {:error, :provider_bridge_unavailable}
        end
    end
  rescue
    _exception -> {:error, :provider_bridge_unavailable}
  catch
    :exit, _reason -> {:error, :provider_bridge_unavailable}
  end

  defp database_observations do
    connection = Database.connection(readiness_episode())

    with {:ok,
          %{
            rows: [
              [
                in_recovery,
                synchronous_commit,
                standby_names,
                server_version_num,
                fsync,
                full_page_writes,
                data_checksums
              ]
            ]
          }} <-
           Postgrex.query(connection, role_query(), [], timeout: @query_timeout_ms),
         {:ok, %{rows: [[migration_version]]}} <-
           Postgrex.query(connection, migration_query(), [], timeout: @query_timeout_ms),
         {:ok,
          %{
            rows: [
              [
                pending_age_ms,
                retention_cleanup_lag_ms,
                pending,
                due,
                retrying,
                attempts,
                code,
                due_id,
                due_kind,
                due_at,
                due_attempts
              ]
            ]
          }} <-
           Postgrex.query(connection, pending_age_query(), [], timeout: @query_timeout_ms),
         {:ok, %{rows: [[synchronous_standbys, wal_lag_bytes]]}} <-
           Postgrex.query(connection, replication_query(), [], timeout: @query_timeout_ms) do
      {:ok,
       %{
         writable_primary: not in_recovery,
         migration_version: migration_version,
         synchronous_commit: synchronous_commit,
         server_version_num: server_version_num,
         fsync: fsync,
         full_page_writes: full_page_writes,
         data_checksums: data_checksums,
         synchronous_standby_names_configured: String.trim(standby_names) != "",
         synchronous_standbys: synchronous_standbys,
         wal_lag_bytes: wal_lag_bytes,
         synchronous_standby_requirement: synchronous_standby_requirement(),
         oldest_pending_lifecycle_intent_ms: pending_age_ms,
         lifecycle_intents: %{
           pending: pending,
           due: due,
           retrying: retrying,
           oldest_attempt_count: attempts,
           oldest_error_code: public_lifecycle_error_code(code)
         },
         retention_cleanup_lag_ms: retention_cleanup_lag_ms
       }, oldest_due_observation(due_id, due_kind, due_at, due_attempts)}
    else
      _error -> {:error, :database_unavailable}
    end
  end

  defp validate_observed_database(database, oldest_due) do
    case validate_database(database) do
      {:error, reason} = error ->
        measurements =
          database
          |> Map.delete(:lifecycle_intents)
          |> Map.merge(%{
            lifecycle_pending: database.lifecycle_intents.pending,
            lifecycle_due: database.lifecycle_intents.due,
            lifecycle_retrying: database.lifecycle_intents.retrying,
            lifecycle_lag_limit_ms: @lifecycle_lag_limit_ms,
            minimum_migration:
              Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration),
            max_wal_lag_bytes: Application.get_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)
          })

        if reason == :lifecycle_intent_lag do
          log_failure(:database_validation, reason, Map.merge(measurements, oldest_due))
          {:error, reason, %{database: database}}
        else
          log_failure(:database_validation, reason, measurements)
          error
        end

      result ->
        result
    end
  end

  defp oldest_due_observation(nil, _kind, _due_at, _attempts),
    do: %{oldest_due_intent: "none"}

  defp oldest_due_observation(id, kind, due_at, attempts) do
    %{
      oldest_due_intent_id: UUID.load!(id),
      oldest_due_intent_kind: kind,
      oldest_due_intent_due_at: DateTime.to_iso8601(due_at),
      oldest_due_intent_attempts: attempts
    }
  end

  defp observe(check, probe, measurements \\ %{observed: false}) do
    result = probe.()

    case result do
      {:error, reason} -> log_failure(check, reason, measurements)
      {:error, reason, _details} -> log_failure(check, reason, measurements)
      _success -> :ok
    end

    result
  end

  defp log_failure(check, reason, measurements) do
    attributes =
      Map.merge(measurements, %{check: Atom.to_string(check), reason: Atom.to_string(reason)})

    context = Observability.root(nil, "sync.readiness.failed", attributes)

    Logger.warning(fn ->
      attributes
      |> Map.merge(Observability.frame_fields(context))
      |> Map.put(:event, "sync.readiness.failed")
      |> JSON.encode!()
    end)
  end

  defp public_lifecycle_error_code(nil), do: nil

  defp public_lifecycle_error_code(code)
       when code in ~w(dependency_unavailable overloaded decision_unavailable episode_not_found
                      lifecycle_intent_not_found invalid_state admission_request_not_found
                      participant_not_found invalid_lifecycle_intent stale_participant_generation
                      invalid_lifecycle_transition episode_ending recording_in_progress),
       do: code

  defp public_lifecycle_error_code(_code), do: "other"

  @doc false
  def validate_database(observations) do
    minimum_migration =
      Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration)

    require_standby? = Application.get_env(:chalk_sync, :require_synchronous_standby, false)
    max_wal_lag = Application.get_env(:chalk_sync, :max_synchronous_wal_lag_bytes, 0)

    case validate_primary_database(observations, minimum_migration) do
      :ok -> validate_synchronous_standby(observations, require_standby?, max_wal_lag)
      error -> error
    end
  end

  defp validate_primary_database(observations, minimum_migration) do
    with :ok <- validate_primary_role_and_schema(observations, minimum_migration),
         :ok <- validate_durability_settings(observations) do
      validate_lifecycle_lag(observations)
    end
  end

  defp validate_primary_role_and_schema(observations, minimum_migration) do
    cond do
      not observations.writable_primary ->
        {:error, :database_not_writable_primary}

      observations.migration_version < minimum_migration ->
        {:error, :incompatible_database_migration}

      observations.server_version_num < 180_000 ->
        {:error, :unsupported_postgres_version}

      true ->
        :ok
    end
  end

  defp validate_durability_settings(observations) do
    cond do
      observations.fsync != "on" or observations.full_page_writes != "on" or
          observations.data_checksums != "on" ->
        {:error, :unsafe_database_durability}

      observations.synchronous_commit not in ["on", "remote_apply"] ->
        {:error, :synchronous_commit_disabled}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_lag(%{oldest_pending_lifecycle_intent_ms: age_ms})
       when age_ms >= @lifecycle_lag_limit_ms,
       do: {:error, :lifecycle_intent_lag}

  defp validate_lifecycle_lag(_observations), do: :ok

  defp validate_synchronous_standby(_observations, false, _max_wal_lag), do: :ok

  defp validate_synchronous_standby(observations, true, max_wal_lag) do
    cond do
      not observations.synchronous_standby_names_configured ->
        {:error, :synchronous_standby_not_configured}

      observations.synchronous_standbys < 1 ->
        {:error, :synchronous_standby_unavailable}

      observations.wal_lag_bytes > max_wal_lag ->
        {:error, :synchronous_standby_lag}

      true ->
        :ok
    end
  end

  @doc false
  @spec synchronous_standby_requirement() :: String.t()
  def synchronous_standby_requirement do
    require_standby? = Application.get_env(:chalk_sync, :require_synchronous_standby, false)

    cond do
      Application.get_env(:chalk_sync, :local_parity, false) and not require_standby? ->
        "disabled_local_parity"

      require_standby? ->
        "required"

      true ->
        "not_required"
    end
  end

  defp process_observations(boot?) do
    with :ok <- observe_process(ChalkSync.Episodes.Supervisor),
         :ok <- observe_process(ChalkSync.CommandTaskSupervisor),
         :ok <- observe_process(ChalkSync.Episodes.CommandIntake),
         :ok <- observe_process(PostgresNotifications),
         :ok <- observe_process(LifecycleConsumer),
         :ok <- observe_process(ExternalOperationConsumer),
         :ok <- observe_process(RetentionScheduler),
         {:ok, fanout} <-
           observe(PostgresNotifications, fn -> safe_health(PostgresNotifications) end),
         {:ok, lifecycle} <- observe(LifecycleConsumer, fn -> safe_health(LifecycleConsumer) end),
         {:ok, external_operations} <-
           observe(ExternalOperationConsumer, fn -> safe_health(ExternalOperationConsumer) end),
         {:ok, retention} <-
           observe(RetentionScheduler, fn -> safe_health(RetentionScheduler) end),
         :ok <-
           observe(
             :lifecycle_consumer,
             fn -> validate_lifecycle_health(lifecycle, boot?) end,
             consumer_measurements(lifecycle)
           ),
         :ok <-
           observe(
             :external_operation_consumer,
             fn -> validate_external_operation_health(external_operations, boot?) end,
             consumer_measurements(external_operations)
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
         external_operation_consumer_consecutive_failures:
           external_operations.consecutive_failures,
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

      external_operation_stale?(health, now) and active_external_operation_work?(health) ->
        :ok

      external_operation_stale?(health, now) ->
        {:error, :external_operation_consumer_stale}

      true ->
        :ok
    end
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

  defp safe_health(ExternalOperationConsumer) do
    {:ok, ExternalOperationConsumer.health()}
  catch
    :exit, _reason -> {:error, :external_operation_consumer_unavailable}
  end

  defp safe_health(RetentionScheduler) do
    {:ok, RetentionScheduler.health()}
  catch
    :exit, _reason -> {:error, :retention_cleanup_unavailable}
  end

  defp observe_process(name) do
    observe(name, fn ->
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

  defp readiness_episode do
    %EpisodeKey{tenant_id: "readiness", space_id: "readiness", episode_id: "readiness"}
  end

  defp role_query do
    """
    select
      pg_is_in_recovery(),
      current_setting('synchronous_commit'),
      current_setting('synchronous_standby_names'),
      current_setting('server_version_num')::integer,
      current_setting('fsync'),
      current_setting('full_page_writes'),
      current_setting('data_checksums')
    """
  end

  defp migration_query do
    """
    select coalesce(max(version_id), 0)
    from (
      select distinct on (version_id) version_id, is_applied
      from goose_db_version
      order by version_id, id desc
    ) latest
    where is_applied
    """
  end

  defp pending_age_query do
    """
    with pending_intents as (
      select lifecycle_intent_id, intent_name, next_attempt_at, attempt_count, last_error_code,
        case
          when intent_name = 'participant_joined' and attempt_count = 0 then next_attempt_at
          else created_at
        end as lag_since
      from sync_lifecycle_intents
      where status = 'pending'
    )
    select
      pending.oldest_age_ms,
      (
        select coalesce(
          (extract(epoch from (now() - min(episode.ended_at) - interval '7 days')) * 1000)::bigint,
          0
        )
        from episodes episode
        join sync_episode_control control
          on control.tenant_id = episode.tenant_id
          and control.space_id = episode.space_id
          and control.episode_id = episode.id
        where episode.status = 'ended'
          and episode.ended_at <= now() - interval '7 days'
          and control.retention_cleaned_at is null
      ),
      pending.total, pending.due, pending.retrying,
      oldest.attempt_count, oldest.last_error_code,
      oldest_due.lifecycle_intent_id, oldest_due.intent_name,
      oldest_due.next_attempt_at, oldest_due.attempt_count
    from (
      select
        greatest((extract(epoch from (now() - min(lag_since))) * 1000)::bigint, 0)
          as oldest_age_ms,
        count(*) as total,
        count(*) filter (where next_attempt_at <= now()) as due,
        count(*) filter (where attempt_count > 0) as retrying
      from pending_intents
    ) pending
    left join lateral (
      select attempt_count, last_error_code
      from pending_intents
      where lag_since <= now()
      order by lag_since, lifecycle_intent_id
      limit 1
    ) oldest on true
    left join lateral (
      select lifecycle_intent_id, intent_name, next_attempt_at, attempt_count
      from pending_intents
      where next_attempt_at <= now()
      order by next_attempt_at, lifecycle_intent_id
      limit 1
    ) oldest_due on true
    """
  end

  defp replication_query do
    """
    select
      count(*)::bigint,
      coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0)::bigint
    from pg_stat_replication
    where state = 'streaming' and sync_state in ('sync', 'quorum')
    """
  end
end
