defmodule ChalkSync.Stateholder.ObservedContext do
  @moduledoc "Durable correlation context captured for one external operation."

  alias ChalkSync.UUID

  @trace_id ~r/\A[0-9a-f]{32}\z/
  @span_id ~r/\A[0-9a-f]{16}\z/

  @enforce_keys [:journey_id, :parent_journey_event_id, :occurred_at]
  defstruct [
    :journey_id,
    :parent_journey_event_id,
    :producing_trace_id,
    :producing_span_id,
    :occurred_at
  ]

  @type t :: %__MODULE__{}

  @spec new(String.t(), String.t(), String.t() | nil, String.t() | nil, DateTime.t()) ::
          {:ok, t()} | {:error, :invalid_observed_context}
  def new(journey_id, parent_id, trace_id, span_id, %DateTime{} = occurred_at) do
    with {:ok, _journey} <- UUID.dump(journey_id),
         {:ok, _parent} <- UUID.dump(parent_id),
         true <- valid_trace?(trace_id),
         true <- valid_span?(span_id),
         true <- is_nil(trace_id) == is_nil(span_id) do
      {:ok,
       %__MODULE__{
         journey_id: String.downcase(journey_id),
         parent_journey_event_id: String.downcase(parent_id),
         producing_trace_id: trace_id,
         producing_span_id: span_id,
         occurred_at: occurred_at
       }}
    else
      _ -> {:error, :invalid_observed_context}
    end
  end

  def new(_journey_id, _parent_id, _trace_id, _span_id, _occurred_at),
    do: {:error, :invalid_observed_context}

  defp valid_trace?(nil), do: true
  defp valid_trace?(value), do: is_binary(value) and Regex.match?(@trace_id, value)
  defp valid_span?(nil), do: true
  defp valid_span?(value), do: is_binary(value) and Regex.match?(@span_id, value)
end
