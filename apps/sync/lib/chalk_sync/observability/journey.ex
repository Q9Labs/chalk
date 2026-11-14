defmodule ChalkSync.Observability.Journey do
  @moduledoc """
  Builds and merges journey contexts from incoming baggage and trace headers.
  """

  alias ChalkSync.Observability.Support
  alias OpenTelemetry.Span

  @journey_id_pattern ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  @session_id_pattern ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

  def build_context(fields) do
    journey_id = valid_journey_id(fields["journey_id"])
    otel_ctx = extract_otel_context(fields)

    %{
      journey_id: journey_id,
      journey_observed?: not is_nil(journey_id),
      session_id: session_id_from_baggage(fields["baggage"]),
      otel_ctx: otel_ctx,
      w3c_trace?: remote_span?(otel_ctx)
    }
  end

  def new_context do
    %{
      journey_id: new_journey_id(),
      journey_observed?: false,
      session_id: nil,
      otel_ctx: :otel_ctx.new(),
      w3c_trace?: false
    }
  end

  def ensure_context(nil), do: new_context()
  def ensure_context(%{journey_id: nil} = context), do: %{context | journey_id: new_journey_id()}
  def ensure_context(context), do: context

  def current_or_incoming_journey(current, _incoming, true), do: current
  def current_or_incoming_journey(current, incoming, false), do: incoming || current

  def current_or_incoming(current, _incoming, true), do: current

  def current_or_incoming(current, incoming, false) do
    if remote_span?(incoming), do: incoming, else: current
  end

  def remote_span?(otel_ctx) do
    Support.safely(
      fn -> otel_ctx |> :otel_tracer.current_span_ctx() |> Span.is_valid() end,
      false
    )
  end

  defp extract_otel_context(fields) do
    carrier =
      fields
      |> Map.take(["traceparent", "tracestate"])
      |> Map.to_list()

    Support.safely(
      fn ->
        :otel_propagator_text_map.extract_to(
          :otel_ctx.new(),
          :otel_propagator_trace_context,
          carrier
        )
      end,
      :otel_ctx.new()
    )
  end

  def maybe_put_tracestate(fields, tracestate) when is_binary(tracestate),
    do: Map.put(fields, "tracestate", tracestate)

  def maybe_put_tracestate(fields, _tracestate), do: fields

  defp valid_journey_id(value) when is_binary(value) do
    normalized = String.downcase(value)

    if Regex.match?(@journey_id_pattern, normalized) and
         String.replace(normalized, "-", "") != String.duplicate("0", 32),
       do: normalized
  end

  defp valid_journey_id(_value), do: nil

  # W3C baggage: comma-separated `key=value;property` members. Only a lowercase
  # UUID `session.id` member is kept; anything else is ignored.
  def put_baggage(fields, headers) do
    case for({key, value} <- headers, String.downcase(key) == "baggage", do: value) do
      [] -> fields
      values -> Map.put(fields, "baggage", Enum.join(values, ","))
    end
  end

  defp session_id_from_baggage(baggage) when is_binary(baggage) do
    baggage
    |> String.split(",")
    |> Enum.find_value(fn member ->
      with [pair | _properties] <- String.split(member, ";"),
           [key, value] <- String.split(pair, "=", parts: 2),
           "session.id" <- String.trim(key),
           value = String.trim(value),
           true <- Regex.match?(@session_id_pattern, value) do
        value
      else
        _other -> nil
      end
    end)
  end

  defp session_id_from_baggage(_baggage), do: nil

  defp new_journey_id do
    <<prefix::binary-size(6), version, next, variant, suffix::binary-size(7)>> =
      :crypto.strong_rand_bytes(16)

    bytes =
      <<prefix::binary, Bitwise.bor(Bitwise.band(version, 0x0F), 0x40), next,
        Bitwise.bor(Bitwise.band(variant, 0x3F), 0x80), suffix::binary>>

    hex = Base.encode16(bytes, case: :lower)

    Enum.join(
      [
        binary_part(hex, 0, 8),
        binary_part(hex, 8, 4),
        binary_part(hex, 12, 4),
        binary_part(hex, 16, 4),
        binary_part(hex, 20, 12)
      ],
      "-"
    )
  end
end
