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

  @doc """
  Runs `fun` and records its wall time as `event` with a fixed `stage` label.
  """
  @spec timed([atom()], atom(), (-> result)) :: result when result: var
  def timed(event, stage, fun) when is_list(event) and is_atom(stage) and is_function(fun, 0) do
    started = System.monotonic_time(:microsecond)
    result = fun.()

    execute(event, %{duration_us: System.monotonic_time(:microsecond) - started}, %{
      outcome: :success,
      stage: stage
    })

    result
  end
end
