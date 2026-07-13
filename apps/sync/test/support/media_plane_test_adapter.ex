defmodule ChalkSync.Live.MediaPlaneTestAdapter do
  @moduledoc false

  @behaviour ChalkSync.MediaPlane

  @max_outcomes 256
  @max_calls 256

  @spec start_link(keyword()) :: Agent.on_start()
  def start_link(options \\ []) do
    outcomes = Keyword.get(options, :outcomes, %{})

    if map_size(outcomes) <= @max_outcomes,
      do: Agent.start_link(fn -> %{outcomes: outcomes, calls: [], observation_sequence: 0} end),
      else: {:error, :outcome_limit}
  end

  @impl true
  def grant_publication(adapter, operation_id, session, participant_session_id, source) do
    call(adapter, :grant_publication, operation_id, [session, participant_session_id, source])
  end

  @impl true
  def revoke_publication(adapter, operation_id, session, participant_session_id, source) do
    call(adapter, :revoke_publication, operation_id, [session, participant_session_id, source])
  end

  @impl true
  def remove_participant(adapter, operation_id, session, participant_session_id) do
    call(adapter, :remove_participant, operation_id, [session, participant_session_id])
  end

  @impl true
  def end_session(adapter, operation_id, session) do
    call(adapter, :end_session, operation_id, [session])
  end

  @impl true
  def observe_session_publications(adapter, session) do
    call(adapter, :observe_session_publications, nil, [session])
  end

  @spec calls(Agent.agent()) :: [tuple()]
  def calls(adapter), do: Agent.get(adapter, &Enum.reverse(&1.calls))

  @spec put_outcome(Agent.agent(), atom() | {atom(), String.t()}, term()) :: :ok
  def put_outcome(adapter, key, outcome) do
    Agent.update(adapter, &put_in(&1, [:outcomes, key], outcome))
  end

  defp call(adapter, operation, operation_id, arguments) do
    Agent.get_and_update(adapter, fn state ->
      key = {operation, operation_id}

      outcome =
        Map.get(state.outcomes, key, Map.get(state.outcomes, operation, default(operation)))

      calls = Enum.take([{operation, operation_id, arguments} | state.calls], @max_calls)
      {outcome, state} = normalize_outcome(operation, outcome, %{state | calls: calls})
      {outcome, state}
    end)
  end

  defp normalize_outcome(
         :observe_session_publications,
         {:ok, publications},
         state
       )
       when is_list(publications) do
    sequence = state.observation_sequence + 1

    {{:ok, %{incarnation: 1, sequence: sequence, publications: publications}},
     %{state | observation_sequence: sequence}}
  end

  defp normalize_outcome(:observe_session_publications, outcome, state), do: {outcome, state}
  defp normalize_outcome(_operation, outcome, state), do: {outcome, state}

  defp default(:observe_session_publications),
    do: {:ok, %{incarnation: 1, sequence: 0, publications: []}}

  defp default(_operation), do: :confirmed
end
