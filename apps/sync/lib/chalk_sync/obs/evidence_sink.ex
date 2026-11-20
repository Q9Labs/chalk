defmodule ChalkSync.Obs.EvidenceSink do
  @moduledoc """
  Enqueues Episode-scoped kernel records in the same Postgres outbox as SDK
  telemetry. No Axiom credential is needed in Sync. The API relay retries the
  committed payload without changing its event ID.
  """

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  @handler "chalk_sync-obs-evidence-sink"

  @spec attach() :: :ok
  def attach do
    case :telemetry.attach(
           @handler,
           [:chalk_sync, :obs, :record],
           &__MODULE__.handle_event/4,
           nil
         ) do
      :ok -> :ok
      {:error, :already_exists} -> :ok
    end
  end

  @doc false
  def handle_event(
        _event,
        _measurements,
        %{"tenant_id" => tenant, "space_id" => space, "episode_id" => episode} = record,
        _config
      ) do
    scope = %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode}
    payload = JSON.encode!([%{service: %{name: "chalk-sync"}, attributes: record}])

    case Postgrex.query(
           Database.connection(scope),
           "insert into telemetry_outbox (tenant_id, payload) values ($1, $2::text::jsonb)",
           [UUID.dump!(tenant), payload],
           timeout: 1_000
         ) do
      {:ok, _result} -> :ok
      {:error, _reason} -> enqueue_failed()
    end
  rescue
    _exception -> enqueue_failed()
  catch
    :exit, _reason -> enqueue_failed()
  end

  def handle_event(_event, _measurements, _record, _config), do: :ok

  defp enqueue_failed do
    Logger.warning("chalk_sync_obs_enqueue_failed")
  end
end
