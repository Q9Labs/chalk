defmodule ChalkSync.Obs.EvidenceSink do
  @moduledoc """
  Enqueues Episode-scoped kernel records in the same Postgres outbox as SDK
  telemetry. No Axiom credential is needed in Sync. The API relay retries the
  committed payload without changing its event ID.

  A record emitted with `ChalkSync.Obs.fact/2` is enqueued here after the fact, once, and a
  failed insert loses it. A record that must survive a crash, such as the Episode's end, is
  built with `ChalkSync.Obs.stage/2` and enqueued with `enqueue!/2` inside the transaction
  that commits the state it witnesses.
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

  @doc """
  Inserts the record in the outbox through `connection`, which is a Postgrex connection or the
  transaction connection of the state change the record witnesses. A failure raises, so that
  transaction rolls back.
  """
  @spec enqueue!(DBConnection.conn(), map()) :: :ok
  def enqueue!(connection, record), do: insert!(connection, record, false)

  @doc """
  Like `enqueue!/2` for the record that commits with a state change. The outbox cap does not
  count or refuse it, so a full outbox, or a Participant's upload holding the Tenant's usage
  row, cannot keep that state change from committing.
  """
  @spec enqueue_witness!(DBConnection.conn(), map()) :: :ok
  def enqueue_witness!(connection, record), do: insert!(connection, record, true)

  defp insert!(connection, %{"tenant_id" => tenant} = record, witness) do
    payload = JSON.encode!([%{service: %{name: "chalk-sync"}, attributes: record}])

    Postgrex.query!(
      connection,
      "insert into telemetry_outbox (tenant_id, payload, witness) values ($1, $2::text::jsonb, $3)",
      [UUID.dump!(tenant), payload, witness],
      timeout: 1_000
    )

    :ok
  end

  @doc false
  def handle_event(
        _event,
        _measurements,
        %{"tenant_id" => tenant, "space_id" => space, "episode_id" => episode} = record,
        _config
      ) do
    scope = %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode}
    enqueue!(Database.connection(scope), record)
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
