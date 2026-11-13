defmodule ChalkSync.Observability do
  @moduledoc """
  The single observability boundary for the sync service.

  It keeps correlation data separate from space and participant state, emits a
  stable telemetry contract, and makes each observed operation a short span.
  A WebSocket is deliberately never represented by one long-lived span.
  """

  use GenServer

  require Logger

  alias ChalkSync.Observability.Correlation
  alias ChalkSync.Observability.Journey
  alias ChalkSync.Observability.Sink
  alias ChalkSync.Observability.Support
  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.UUID

  @event [:chalk_sync, :observability, :event]
  @runtime_event [:chalk_sync, :runtime, :health]
  @runtime_interval_ms 30_000
  @type context :: Correlation.context()

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  defdelegate context(carrier), to: Correlation
  defdelegate merge(current, incoming), to: Correlation
  defdelegate frame_fields(context), to: Correlation
  defdelegate persisted_context(journey_id, trace_id, span_id), to: Correlation

  defdelegate persisted_context(journey_id, trace_id, span_id, traceparent, tracestate),
    to: Correlation

  @doc "Sets the connection process's Logger metadata from its context."
  @spec bind_logger(context() | nil) :: :ok
  def bind_logger(%{session_id: session_id}) when is_binary(session_id) do
    # The key is read by log handlers; the console format does not print it.
    # credo:disable-for-next-line Credo.Check.Warning.MissedMetadataKeyInLoggerConfig
    Logger.metadata(session_id: session_id)
  end

  def bind_logger(_context), do: :ok

  @doc "Captures one operation's durable journey and W3C producing context."
  @spec observed_operation_context(context() | nil) :: ObservedContext.t()
  def observed_operation_context(context) do
    context = Journey.ensure_context(context)

    metadata =
      Support.safely(
        fn -> Sink.span_metadata(:otel_tracer.current_span_ctx(context.otel_ctx)) end,
        []
      )

    {:ok, observed} =
      ObservedContext.new(
        context.journey_id,
        UUID.generate(),
        Keyword.get(metadata, :trace_id),
        Keyword.get(metadata, :span_id),
        DateTime.utc_now()
      )

    fields = Correlation.frame_fields(context)
    ObservedContext.with_w3c(observed, fields["traceparent"], fields["tracestate"])
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

  @doc "Emits the bounded phase for a committed Episode control event."
  @spec episode_event(context() | nil, map()) :: context()
  def episode_event(context, event) when is_map(event) do
    linked_phase(context, "sync.episode.event.committed", %{
      event_name: Sink.bounded_episode_event_name(event)
    })
  end

  @doc "Emits a short span for work that crossed an OTP process boundary while preserving the explicit upstream trace context."
  @spec linked_phase(context() | nil, String.t(), map()) :: context()
  def linked_phase(context, name, attributes \\ %{}) do
    context = Journey.ensure_context(context)
    metadata = Sink.metadata(context, name, attributes, :phase)
    Support.safely(fn -> :telemetry.execute(@event, %{count: 1}, metadata) end, :ok)

    if enabled?() do
      Support.safely(fn -> Sink.export_linked(context, name, attributes, metadata) end, :ok)
      Support.safely(fn -> Sink.log(metadata, context) end, :ok)
      Support.safely(fn -> Sink.deliver_to_sink(metadata) end, :ok)
    end

    context
  end

  @doc "Runs crossed-process work in a short child span and exposes its context to the callback."
  @spec with_worker_span(context() | nil, String.t(), map(), (context() -> result)) :: result
        when result: term()
  def with_worker_span(context, name, attributes, callback)
      when is_function(callback, 1) do
    context = Journey.ensure_context(context)
    metadata = Sink.metadata(context, name, attributes, :phase)
    Support.safely(fn -> :telemetry.execute(@event, %{count: 1}, metadata) end, :ok)

    if enabled?() do
      span =
        :otel_tracer.start_span(
          context.otel_ctx,
          :opentelemetry.get_application_tracer(__MODULE__),
          name,
          %{kind: :internal, attributes: Sink.span_attributes(metadata, attributes)}
        )

      worker_context = %{
        context
        | otel_ctx: :otel_tracer.set_current_span(context.otel_ctx, span)
      }

      Support.safely(fn -> Sink.log(metadata, worker_context) end, :ok)
      Support.safely(fn -> Sink.deliver_to_sink(metadata) end, :ok)

      try do
        callback.(worker_context)
      after
        Support.safely(
          fn -> :otel_span.add_event(span, name, Sink.span_attributes(metadata, attributes)) end,
          :ok
        )

        Support.safely(fn -> :otel_span.end_span(span) end, :ok)
      end
    else
      callback.(context)
    end
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

    Support.safely(
      fn -> :telemetry.execute(@runtime_event, measurements, %{component: "beam"}) end,
      :ok
    )

    phase(nil, "sync.runtime.health", %{
      component: "beam",
      memory_total_bytes: measurements.memory_total_bytes,
      process_count: measurements.process_count,
      process_limit: measurements.process_limit,
      run_queue: measurements.run_queue
    })
  end

  def enabled? do
    Support.config() |> Map.get(:enabled, false)
  end

  defp emit(context, name, attributes, stage) do
    context = Journey.ensure_context(context)
    metadata = Sink.metadata(context, name, attributes, stage)
    Support.safely(fn -> :telemetry.execute(@event, %{count: 1}, metadata) end, :ok)

    if enabled?() do
      context =
        Support.safely(fn -> Sink.export(context, name, attributes, metadata) end, context)

      Support.safely(fn -> Sink.log(metadata, context) end, :ok)
      Support.safely(fn -> Sink.deliver_to_sink(metadata) end, :ok)
      context
    else
      context
    end
  end

  defp runtime_interval_ms do
    case Map.get(Support.config(), :runtime_health_interval_ms, @runtime_interval_ms) do
      interval when is_integer(interval) and interval > 0 -> interval
      _ -> @runtime_interval_ms
    end
  end
end
