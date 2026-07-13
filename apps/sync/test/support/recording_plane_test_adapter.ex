defmodule ChalkSync.RecordingPlaneTestAdapter do
  @moduledoc false

  @behaviour ChalkSync.RecordingPlane

  @max_outcomes 256
  @max_calls 256

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(options \\ []) do
    outcomes = Keyword.get(options, :outcomes, %{})

    if map_size(outcomes) <= @max_outcomes,
      do: Agent.start_link(fn -> %{outcomes: outcomes, calls: []} end),
      else: {:error, :outcome_limit}
  end

  @impl true
  def start_recording(adapter, operation_id, session, recording_id),
    do: call(adapter, :start_recording, operation_id, [session, recording_id])

  @impl true
  def stop_recording(adapter, operation_id, session, recording_id),
    do: call(adapter, :stop_recording, operation_id, [session, recording_id])

  @spec calls(Agent.agent()) :: [tuple()]
  def calls(adapter), do: Agent.get(adapter, &Enum.reverse(&1.calls))

  defp call(adapter, operation, operation_id, arguments) do
    Agent.get_and_update(adapter, fn state ->
      outcome = Map.get(state.outcomes, {operation, operation_id}, :confirmed)
      calls = Enum.take([{operation, operation_id, arguments} | state.calls], @max_calls)
      {outcome, %{state | calls: calls}}
    end)
  end
end
