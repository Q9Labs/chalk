defmodule ChalkSync.Observability do
  @moduledoc """
  The single observability boundary for the sync service.

  It keeps correlation data separate from room and participant state, emits a
  stable telemetry contract, and makes each observed operation a short span.
  A WebSocket is deliberately never represented by one long-lived span.
  """

  use GenServer

  require Logger

  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.UUID
  alias OpenTelemetry.Span

  @event [:chalk_sync, :observability, :event]
  @runtime_event [:chalk_sync, :runtime, :health]
  @runtime_interval_ms 30_000
  @journey_id_pattern ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  @type context :: %{
          journey_id: String.t() | nil,
          journey_observed?: boolean(),
          otel_ctx: map(),
          w3c_trace?: boolean()
        }

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  @doc "Builds correlation context from HTTP headers or protocol-frame fields."
  @spec context(map() | [{String.t(), String.t()}] | nil) :: context() | nil
  def context(nil), do: nil

  def context(carrier) when is_map(carrier) do
    fields = Map.take(carrier, ["journey_id", "traceparent", "tracestate"])

    if fields == %{}, do: nil, else: build_context(fields)
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

    if fields == %{}, do: nil, else: build_context(fields)
  end

  @doc "Merges missing protocol-frame context into a connection's existing context."
  @spec merge(context() | nil, context() | nil) :: context()
  def merge(nil, nil), do: new_context()
  def merge(nil, incoming), do: incoming
  def merge(current, nil), do: current

  def merge(current, %{otel_ctx: incoming_otel_ctx, journey_id: incoming_journey_id} = incoming) do
    current = Map.put_new(current, :journey_observed?, not is_nil(current.journey_id))
    current = Map.put_new(current, :w3c_trace?, remote_span?(current.otel_ctx))
    incoming_journey? = Map.get(incoming, :journey_observed?, not is_nil(incoming_journey_id))
    incoming_trace? = remote_span?(incoming_otel_ctx)

    %{
      current
      | journey_id:
          current_or_incoming_journey(
            current.journey_id,
            incoming_journey_id,
            current.journey_observed?
          ),
        journey_observed?: current.journey_observed? or incoming_journey?,
        otel_ctx: current_or_incoming(current.otel_ctx, incoming_otel_ctx, current.w3c_trace?),
        w3c_trace?: current.w3c_trace? or incoming_trace?
    }
  end

  @doc "Returns the public, optional context fields for a protocol frame."
  @spec frame_fields(context() | nil) :: map()
  def frame_fields(nil), do: %{}

  def frame_fields(context) do
    headers =
      safely(
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

  @doc "Captures one operation's durable journey and W3C producing context."
  @spec observed_operation_context(context() | nil) :: ObservedContext.t()
  def observed_operation_context(context) do
    context = ensure_context(context)

    metadata =
      safely(fn -> span_metadata(:otel_tracer.current_span_ctx(context.otel_ctx)) end, [])

    {:ok, observed} =
      ObservedContext.new(
        context.journey_id,
        UUID.generate(),
        Keyword.get(metadata, :trace_id),
        Keyword.get(metadata, :span_id),
        DateTime.utc_now()
      )

    observed
  end

  @doc "Reconstructs a bounded context from correlation fields stored with durable work."
  @spec persisted_context(String.t(), String.t() | nil, String.t() | nil) :: context()
  def persisted_context(journey_id, trace_id, span_id) do
    fields =
      if is_binary(trace_id) and is_binary(span_id) do
        %{
          "journey_id" => journey_id,
          "traceparent" => "00-#{trace_id}-#{span_id}-01"
        }
      else
        %{"journey_id" => journey_id}
      end

    build_context(fields)
  end

  @doc "Emits the root event for a journey that starts at this service."
  @spec root(context() | nil, String.t(), map()) :: context()
  def root(context, name, attributes \\ %{}), do: emit(context, name, attributes, :root)

  @doc "Emits a bounded phase event."
  @spec phase(context() | nil, String.t(), map()) :: context()
  def phase(context, name, attributes \\ %{}), do: emit(context, name, attributes, :phase)

  @doc "Emits a terminal event. Every close path calls this once from `terminate/2`."
  @spec terminal(context() | nil, String.t(), map()) :: context()
  def terminal(context, name, attributes \\ %{}), do: emit(context, name, attributes, :terminal)

  @doc "Emits a short span for work that crossed an OTP process boundary while preserving the explicit upstream trace context."
  @spec linked_phase(context() | nil, String.t(), map()) :: context()
  def linked_phase(context, name, attributes \\ %{}) do
    context = ensure_context(context)
    metadata = metadata(context, name, attributes, :phase)
    safely(fn -> :telemetry.execute(@event, %{count: 1}, metadata) end, :ok)

    if enabled?() do
      safely(fn -> export_linked(context, name, attributes, metadata) end, :ok)
      safely(fn -> log(metadata, context) end, :ok)
      safely(fn -> deliver_to_sink(metadata) end, :ok)
    end

    context
  end

  @doc "Returns whether the dependencies that make sync state authoritative are running."
  @spec ready?() :: boolean()
  def ready? do
    room_services_ready?() and stateholder_ready?()
  end

  @impl true
  def init(_opts) do
    send(self(), :emit_runtime_health)
    {:ok, %{interval_ms: runtime_interval_ms()}}
  end

  @impl true
  def handle_info(:emit_runtime_health, state) do
    runtime_health()
    Process.send_after(self(), :emit_runtime_health, state.interval_ms)
    {:noreply, state}
  end

  @doc false
  def runtime_health do
    measurements = %{
      memory_total_bytes: :erlang.memory(:total),
      process_count: :erlang.system_info(:process_count),
      process_limit: :erlang.system_info(:process_limit),
      run_queue: :erlang.statistics(:run_queue)
    }

    safely(fn -> :telemetry.execute(@runtime_event, measurements, %{component: "beam"}) end, :ok)

    phase(nil, "sync.runtime.health", %{
      component: "beam",
      memory_total_bytes: measurements.memory_total_bytes,
      process_count: measurements.process_count,
      process_limit: measurements.process_limit,
      run_queue: measurements.run_queue
    })
  end

  def enabled? do
    config() |> Map.get(:enabled, false)
  end

  defp emit(context, name, attributes, stage) do
    context = ensure_context(context)
    metadata = metadata(context, name, attributes, stage)
    safely(fn -> :telemetry.execute(@event, %{count: 1}, metadata) end, :ok)

    if enabled?() do
      context = safely(fn -> export(context, name, attributes, metadata) end, context)
      safely(fn -> log(metadata, context) end, :ok)
      safely(fn -> deliver_to_sink(metadata) end, :ok)
      context
    else
      context
    end
  end

  defp build_context(fields) do
    journey_id = valid_journey_id(fields["journey_id"])
    otel_ctx = extract_otel_context(fields)

    %{
      journey_id: journey_id,
      journey_observed?: not is_nil(journey_id),
      otel_ctx: otel_ctx,
      w3c_trace?: remote_span?(otel_ctx)
    }
  end

  defp new_context do
    %{
      journey_id: new_journey_id(),
      journey_observed?: false,
      otel_ctx: :otel_ctx.new(),
      w3c_trace?: false
    }
  end

  defp ensure_context(nil), do: new_context()
  defp ensure_context(%{journey_id: nil} = context), do: %{context | journey_id: new_journey_id()}
  defp ensure_context(context), do: context

  defp current_or_incoming_journey(current, _incoming, true), do: current
  defp current_or_incoming_journey(current, incoming, false), do: incoming || current

  defp current_or_incoming(current, _incoming, true), do: current

  defp current_or_incoming(current, incoming, false) do
    if remote_span?(incoming), do: incoming, else: current
  end

  defp remote_span?(otel_ctx) do
    safely(fn -> otel_ctx |> :otel_tracer.current_span_ctx() |> Span.is_valid() end, false)
  end

  defp extract_otel_context(fields) do
    carrier =
      fields
      |> Map.take(["traceparent", "tracestate"])
      |> Map.to_list()

    safely(
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

  defp export(context, name, attributes, metadata) do
    span =
      :otel_tracer.start_span(
        context.otel_ctx,
        :opentelemetry.get_application_tracer(__MODULE__),
        name,
        %{kind: :internal, attributes: span_attributes(metadata, attributes)}
      )

    :otel_span.add_event(span, name, span_attributes(metadata, attributes))
    ended_span = :otel_span.end_span(span)
    %{context | otel_ctx: :otel_tracer.set_current_span(context.otel_ctx, ended_span)}
  end

  defp export_linked(context, name, attributes, metadata) do
    options = %{
      kind: :internal,
      attributes: span_attributes(metadata, attributes)
    }

    span =
      :otel_tracer.start_span(
        context.otel_ctx,
        :opentelemetry.get_application_tracer(__MODULE__),
        name,
        options
      )

    :otel_span.add_event(span, name, span_attributes(metadata, attributes))
    :otel_span.end_span(span)
  end

  defp metadata(context, name, attributes, stage) do
    %{
      event: name,
      journey_id: context.journey_id,
      attributes: attributes,
      stage: Atom.to_string(stage)
    }
  end

  defp span_attributes(metadata, attributes) do
    Map.merge(attributes, %{
      "chalk.journey.id" => metadata.journey_id,
      "chalk.sync.event" => metadata.event,
      "chalk.sync.stage" => metadata.stage
    })
  end

  defp log(metadata, context) do
    trace_metadata =
      case context do
        nil ->
          []

        %{otel_ctx: otel_ctx} ->
          safely(fn -> span_metadata(:otel_tracer.current_span_ctx(otel_ctx)) end, [])
      end

    Logger.info(
      "chalk_sync_observability",
      [
        observability_event: metadata.event,
        journey_id: metadata.journey_id,
        observability_stage: metadata.stage,
        observability_attributes: metadata.attributes
      ] ++ trace_metadata
    )
  end

  defp span_metadata(nil), do: []

  defp span_metadata(span) do
    [trace_id: Span.hex_trace_id(span), span_id: Span.hex_span_id(span)]
  end

  defp deliver_to_sink(metadata) do
    case config() do
      %{event_sink: sink} when is_function(sink, 1) -> sink.(metadata)
      _ -> :ok
    end
  end

  defp room_services_ready? do
    Enum.all?(
      [ChalkSync.Rooms.Registry, ChalkSync.Rooms.Supervisor],
      &is_pid(Process.whereis(&1))
    )
  end

  defp stateholder_ready? do
    case ChalkSync.Stateholder.impl() do
      ChalkSync.Stateholder.Memory -> is_pid(Process.whereis(ChalkSync.Stateholder.Memory))
      _adapter -> true
    end
  end

  defp config do
    :chalk_sync
    |> Application.get_env(:observability, [])
    |> Map.new()
  end

  defp runtime_interval_ms do
    case Map.get(config(), :runtime_health_interval_ms, @runtime_interval_ms) do
      interval when is_integer(interval) and interval > 0 -> interval
      _ -> @runtime_interval_ms
    end
  end

  defp valid_journey_id(value) when is_binary(value) do
    normalized = String.downcase(value)

    if Regex.match?(@journey_id_pattern, normalized) and
         String.replace(normalized, "-", "") != String.duplicate("0", 32),
       do: normalized
  end

  defp valid_journey_id(_value), do: nil

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

  defp safely(fun, fallback) do
    fun.()
  rescue
    _exception -> fallback
  catch
    :exit, _reason -> fallback
  end
end
