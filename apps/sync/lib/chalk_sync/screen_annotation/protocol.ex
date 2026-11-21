defmodule ChalkSync.ScreenAnnotation.Protocol do
  @moduledoc "Exact validation for the separately negotiated annotation sideband."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.UUID

  @definitions Schema.definitions()
  @limits Schema.limits()
  @types %{
    "annotation_state_request" => "ClientRequest",
    "annotation_command" => "ClientCommand",
    "annotation_presence" => "ClientPresence"
  }
  @operation_id ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/
  @context ["journey_id", "traceparent", "tracestate"]

  def decode(%{"type" => type} = frame, bytes) when is_map_key(@types, type) do
    limit =
      if type == "annotation_presence",
        do: @limits["presenceBytes"],
        else: @limits["commandBytes"]

    payload = Map.drop(frame, @context)

    if bytes <= limit and GeneratedV1.valid_correlation_fields?(frame) and
         valid?(payload, Map.fetch!(@definitions, @types[type])) do
      {:extension, {:screen_annotation, payload}}
    else
      {:error, :invalid_annotation_frame}
    end
  end

  def decode(_frame, _bytes), do: :base

  def operation_time(%{"operation_id" => id}, now) do
    with {:ok, <<ms::48, 7::4, _::12, 2::2, _::62>>} <- operation_bytes(id),
         true <- ms > now - @limits["operationReceiptTtlMs"],
         true <- ms <= now + @limits["operationFutureSkewMs"] do
      {:ok, ms + @limits["operationReceiptTtlMs"]}
    else
      _ -> {:error, "invalid_target"}
    end
  end

  def operation_bytes(id) when is_binary(id) do
    if Regex.match?(@operation_id, id),
      do: id |> String.replace("-", "") |> Base.decode16(case: :lower),
      else: :error
  end

  defp valid?(value, %{"$ref" => "#/$defs/" <> name}),
    do: valid?(value, Map.fetch!(@definitions, name))

  defp valid?(value, %{"oneOf" => alternatives}), do: Enum.any?(alternatives, &valid?(value, &1))
  defp valid?(value, %{"const" => expected}), do: value === expected
  defp valid?(value, %{"enum" => choices}), do: value in choices

  defp valid?(value, %{"type" => "object", "properties" => fields, "required" => required}) do
    is_map(value) and map_size(value) == length(required) and
      Enum.all?(required, fn key ->
        Map.has_key?(value, key) and valid_field?(key, value[key], fields[key])
      end)
  end

  defp valid?(value, %{"type" => "array", "items" => item} = schema) do
    is_list(value) and length(value) in Map.get(schema, "minItems", 0)..schema["maxItems"] and
      Enum.all?(value, &valid?(&1, item))
  end

  defp valid?(value, %{"type" => "string", "format" => "uuid"}) when is_binary(value) do
    match?({:ok, _}, UUID.dump(value)) and value == String.downcase(value)
  end

  defp valid?(value, %{"type" => "string", "pattern" => pattern}) when is_binary(value),
    do: Regex.match?(Regex.compile!(pattern), value)

  defp valid?(value, %{"type" => "string"} = schema) when is_binary(value),
    do: byte_size(value) in Map.get(schema, "minLength", 0)..schema["maxLength"]

  defp valid?(value, %{"type" => "integer"} = schema),
    do: is_integer(value) and value in schema["minimum"]..schema["maximum"]

  defp valid?(value, %{"type" => "boolean"}), do: is_boolean(value)
  defp valid?(value, %{"type" => "null"}), do: is_nil(value)
  defp valid?(_value, _schema), do: false

  defp valid_field?(key, value, _schema)
       when key in ["operation_id", "request_id"] and is_binary(value),
       do: match?({:ok, _}, operation_bytes(value))

  defp valid_field?(key, _value, _schema) when key in ["operation_id", "request_id"], do: false
  defp valid_field?(_key, value, schema), do: valid?(value, schema)
end
