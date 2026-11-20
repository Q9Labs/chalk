defmodule ChalkSync.Obs.LogSink do
  @moduledoc """
  The production subscriber of the observability kernel: it writes every record of `[:chalk_sync, :obs, :record]` as one
  log row, the record's JSON object in the registry row shape (registry field names, `kind` and `name`), the same shape the
  API and SFU kernels write. The application attaches it at boot.

  A record the encoder can't write is counted as a fixed warning line that names only the registry event, so a bad record
  never detaches the handler or puts its own values in a row.
  """

  require Logger

  @handler "chalk_sync-obs-log-sink"

  @doc "Attaches the sink once. Attaching again keeps the first handler."
  @spec attach() :: :ok
  def attach do
    case :telemetry.attach(@handler, [:chalk_sync, :obs, :record], &__MODULE__.handle_event/4, nil) do
      :ok -> :ok
      {:error, :already_exists} -> :ok
    end
  end

  @doc false
  def handle_event(_event, _measurements, record, _config) do
    Logger.info(row(record))
  rescue
    _exception ->
      Logger.warning("chalk_sync_obs_log_failed", obs_event: Map.get(record, "name"))
  end

  @doc "The log row of a record: its JSON object."
  @spec row(map()) :: String.t()
  def row(record), do: JSON.encode!(record)
end
