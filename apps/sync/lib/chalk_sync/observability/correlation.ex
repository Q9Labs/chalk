defmodule ChalkSync.Observability.Correlation do
  @moduledoc """
  Correlation context from HTTP headers, protocol-frame fields and persisted work, and how contexts merge.
  """

  alias ChalkSync.Observability.Journey
  alias ChalkSync.Observability.Support

  @type context :: %{
          journey_id: String.t() | nil,
          journey_observed?: boolean(),
          session_id: String.t() | nil,
          otel_ctx: map(),
          w3c_trace?: boolean()
        }

  @doc """
  Builds correlation context from HTTP headers or protocol-frame fields.

  The `baggage` header or hello field may carry the connection's `session.id`.
  It is connection-scoped: it never reaches `frame_fields/1` or durable work.
  """
  @spec context(map() | [{String.t(), String.t()}] | nil) :: context() | nil
  def context(nil), do: nil

  def context(carrier) when is_map(carrier) do
    fields = Map.take(carrier, ["journey_id", "traceparent", "tracestate", "baggage"])

    if fields == %{}, do: nil, else: Journey.build_context(fields)
  end

  def context(headers) when is_list(headers) do
    fields =
      headers
      |> Map.new(fn {key, value} -> {String.downcase(key), value} end)
      |> Map.take(["x-chalk-journey-id", "traceparent", "tracestate"])
      |> Map.new(fn
        {"x-chalk-journey-id", value} -> {"journey_id", value}
        pair -> pair
      end)
      |> Journey.put_baggage(headers)

    if fields == %{}, do: nil, else: Journey.build_context(fields)
  end

  @doc "Merges missing protocol-frame context into a connection's existing context."
  @spec merge(context() | nil, context() | nil) :: context()
  def merge(nil, nil), do: Journey.new_context()
  def merge(nil, incoming), do: incoming
  def merge(current, nil), do: current

  def merge(current, %{otel_ctx: incoming_otel_ctx, journey_id: incoming_journey_id} = incoming) do
    current = Map.put_new(current, :journey_observed?, not is_nil(current.journey_id))
    current = Map.put_new(current, :w3c_trace?, Journey.remote_span?(current.otel_ctx))
    incoming_journey? = Map.get(incoming, :journey_observed?, not is_nil(incoming_journey_id))
    incoming_trace? = Journey.remote_span?(incoming_otel_ctx)

    %{
      current
      | journey_id:
          Journey.current_or_incoming_journey(
            current.journey_id,
            incoming_journey_id,
            current.journey_observed?
          ),
        journey_observed?: current.journey_observed? or incoming_journey?,
        session_id: current.session_id || incoming.session_id,
        otel_ctx:
          Journey.current_or_incoming(current.otel_ctx, incoming_otel_ctx, current.w3c_trace?),
        w3c_trace?: current.w3c_trace? or incoming_trace?
    }
  end

  @doc "Returns the public, optional context fields for a protocol frame."
  @spec frame_fields(context() | nil) :: map()
  def frame_fields(nil), do: %{}

  def frame_fields(context) do
    headers =
      Support.safely(
        fn ->
          :otel_propagator_text_map.inject_from(
            context.otel_ctx,
            :otel_propagator_trace_context,
            []
          )
        end,
        []
      )

    headers
    |> Map.new()
    |> Map.take(["traceparent", "tracestate"])
    |> Map.put("journey_id", context.journey_id)
  end

  @doc "Reconstructs a bounded context from correlation fields stored with durable work."
  @spec persisted_context(String.t(), String.t() | nil, String.t() | nil) :: context()
  def persisted_context(journey_id, trace_id, span_id),
    do: persisted_context(journey_id, trace_id, span_id, nil, nil)

  @spec persisted_context(
          String.t(),
          String.t() | nil,
          String.t() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: context()
  def persisted_context(journey_id, trace_id, span_id, traceparent, tracestate) do
    fields =
      cond do
        is_binary(traceparent) ->
          %{"journey_id" => journey_id, "traceparent" => traceparent}
          |> Journey.maybe_put_tracestate(tracestate)

        is_binary(trace_id) and is_binary(span_id) ->
          %{
            "journey_id" => journey_id,
            "traceparent" => "00-#{trace_id}-#{span_id}-01"
          }

        true ->
          %{"journey_id" => journey_id}
      end

    Journey.build_context(fields)
  end
end
