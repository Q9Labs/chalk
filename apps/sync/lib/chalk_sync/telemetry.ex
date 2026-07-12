defmodule ChalkSync.Telemetry do
  @moduledoc """
  Low-cardinality telemetry boundary for sync runtime measurements.

  Callers provide only bounded outcome labels and numeric measurements. Tokens,
  participant names, command payloads, and customer identifiers never enter
  this boundary.
  """

  @prefix [:chalk, :sync]

  @spec execute([atom()], map(), map()) :: :ok
  def execute(event, measurements \\ %{}, metadata \\ %{})
      when is_list(event) and is_map(measurements) and is_map(metadata) do
    :telemetry.execute(@prefix ++ event, measurements, metadata)
  end
end
