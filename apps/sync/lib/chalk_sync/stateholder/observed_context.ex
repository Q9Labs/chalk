defmodule ChalkSync.Stateholder.ObservedContext do
  @moduledoc "Durable correlation context captured for one external operation."

  alias ChalkSync.UUID

  @trace_id ~r/\A[0-9a-f]{32}\z/
  @span_id ~r/\A[0-9a-f]{16}\z/
  @traceparent ~r/\A00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\z/
  @tracestate ~r/\A[a-z][a-z0-9_*\x2f-]{0,255}=[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,256}(,[a-z][a-z0-9_*\x2f-]{0,255}=[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,256})*\z/

  @enforce_keys [:journey_id, :parent_journey_event_id, :occurred_at]
  defstruct [
    :journey_id,
    :parent_journey_event_id,
    :producing_trace_id,
    :producing_span_id,
    :producing_traceparent,
    :producing_tracestate,
    :occurred_at
  ]

  @type t :: %__MODULE__{
          journey_id: String.t(),
          parent_journey_event_id: String.t(),
          producing_trace_id: String.t() | nil,
          producing_span_id: String.t() | nil,
          producing_traceparent: String.t() | nil,
          producing_tracestate: String.t() | nil,
          occurred_at: DateTime.t()
        }

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

  @doc "Retains the validated W3C carrier alongside its legacy trace/span fields."
  @spec with_w3c(t(), String.t() | nil, String.t() | nil) :: t()
  def with_w3c(%__MODULE__{} = context, traceparent, tracestate) do
    if valid_traceparent?(traceparent) and valid_tracestate?(tracestate) and
         matching_trace_ids?(context, traceparent) do
      %{
        context
        | producing_traceparent: traceparent,
          producing_tracestate: tracestate
      }
    else
      context
    end
  end

  defp valid_trace?(nil), do: true
  defp valid_trace?(value), do: is_binary(value) and Regex.match?(@trace_id, value)
  defp valid_span?(nil), do: true
  defp valid_span?(value), do: is_binary(value) and Regex.match?(@span_id, value)

  defp valid_traceparent?(value) do
    is_binary(value) and Regex.match?(@traceparent, value) and
      not String.starts_with?(value, "00-00000000000000000000000000000000-") and
      not String.ends_with?(value, "-0000000000000000-00")
  end

  defp valid_tracestate?(nil), do: true

  defp valid_tracestate?(value),
    do: is_binary(value) and byte_size(value) <= 512 and Regex.match?(@tracestate, value)

  defp matching_trace_ids?(
         %__MODULE__{producing_trace_id: trace_id, producing_span_id: span_id},
         traceparent
       )
       when is_binary(trace_id) and is_binary(span_id) do
    binary_part(traceparent, 3, 32) == trace_id and binary_part(traceparent, 36, 16) == span_id
  end

  defp matching_trace_ids?(_context, _traceparent), do: false
end
