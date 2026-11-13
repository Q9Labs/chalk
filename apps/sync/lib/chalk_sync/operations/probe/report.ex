defmodule ChalkSync.Operations.Probe.Report do
  @moduledoc """
  Records one probe observation or failure.
  """

  require Logger
  alias ChalkSync.Observability

  def observe(check, probe, measurements \\ %{observed: false}) do
    result = probe.()

    case result do
      {:error, reason} -> record_failure(check, reason, measurements)
      {:error, reason, _details} -> record_failure(check, reason, measurements)
      _success -> :ok
    end

    result
  end


  @doc false
  @spec record_failure(atom(), atom(), map()) :: :ok
  def record_failure(check, reason, measurements) do
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
end
