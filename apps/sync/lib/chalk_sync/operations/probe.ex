defmodule ChalkSync.Operations.Probe do
  @moduledoc false

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.Operations.Probe.Database
  alias ChalkSync.Operations.Probe.Report
  alias ChalkSync.Operations.Probe.Workers
  alias ChalkSync.ProviderBridge.Client, as: ProviderBridgeClient
  alias ChalkSync.ProviderBridge.Config, as: ProviderBridgeConfig

  @spec run(keyword()) :: {:ok, map()} | {:error, atom()} | {:error, atom(), map()}
  def run(options \\ []) do
    boot? = Keyword.get(options, :boot?, false)

    with :ok <- Report.observe(:production_modules, &production_modules/0),
         {:ok, provider_bridge} <-
           Report.observe(:provider_bridge, &provider_bridge_observation/0),
         {:ok, database, oldest_due} <-
           Report.observe(:database, &Database.database_observations/0),
         :ok <- Database.validate_observed_database(database, oldest_due),
         {:ok, processes} <- Workers.process_observations(boot?) do
      {:ok, %{database: database, processes: processes, provider_bridge: provider_bridge}}
    end
  rescue
    _exception ->
      Report.record_failure(:probe, :probe_failed, %{observed: "exception"})
      {:error, :probe_failed}
  catch
    :exit, _reason ->
      Report.record_failure(:probe, :probe_failed, %{observed: "exit"})
      {:error, :probe_failed}
  end

  defp production_modules do
    verifier = Application.fetch_env!(:chalk_sync, :token_verifier)
    require_auth? = Application.get_env(:chalk_sync, :require_production_auth, false)

    with :ok <- validate_production_modules(verifier, require_auth?) do
      validate_provider_bridge_config(require_auth?)
    end
  end

  defp validate_production_modules(verifier, require_auth?) do
    cond do
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
end
