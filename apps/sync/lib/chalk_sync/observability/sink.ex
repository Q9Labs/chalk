defmodule ChalkSync.Observability.Sink do
  @moduledoc """
  Delivers one observed event to the log, the test sink and the trace exporter.
  """

  require Logger
  alias ChalkSync.Observability.Support
  alias OpenTelemetry.Span

  @episode_event_names ~w(
    admission_denied admission_expired admission_policy_changed admission_requested
    deadline_changed episode_ended episode_started hand_lowered hand_raised
    participant_camera_stopped participant_display_name_changed participant_joined
    participant_left participant_microphone_stopped participant_screen_share_stopped
    recording_status_changed role_assigned
  )

  def export(context, name, attributes, metadata) do
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

  def export_linked(context, name, attributes, metadata) do
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

  def metadata(context, name, attributes, stage) do
    %{
      event: name,
      journey_id: context.journey_id,
      session_id: context.session_id,
      attributes: attributes,
      stage: Atom.to_string(stage)
    }
  end

  @doc false
  def span_attributes(metadata, attributes) do
    attributes
    |> Map.merge(%{
      "chalk.journey.id" => metadata.journey_id,
      "chalk.sync.event" => metadata.event,
      "chalk.sync.stage" => metadata.stage
    })
    |> put_session_id(metadata, "session.id")
  end

  defp put_session_id(fields, %{session_id: session_id}, key) when is_binary(session_id),
    do: Map.put(fields, key, session_id)

  defp put_session_id(fields, _metadata, _key), do: fields

  def log(metadata, context) do
    trace_metadata =
      case context do
        nil ->
          []

        %{otel_ctx: otel_ctx} ->
          Support.safely(fn -> span_metadata(:otel_tracer.current_span_ctx(otel_ctx)) end, [])
      end

    Logger.info(
      if(
        metadata.event in [
          "sync.websocket.handshake",
          "sync.websocket.authenticated",
          "sync.websocket.closed"
        ],
        do:
          JSON.encode!(
            metadata.attributes
            |> Map.merge(%{event: metadata.event, journey_id: metadata.journey_id})
            |> put_session_id(metadata, "session.id")
          ),
        else: "chalk_sync_observability"
      ),
      [
        observability_event: metadata.event,
        journey_id: metadata.journey_id,
        observability_stage: metadata.stage,
        observability_attributes: metadata.attributes
      ] ++ session_metadata(metadata) ++ trace_metadata
    )
  end

  defp session_metadata(%{session_id: session_id}) when is_binary(session_id),
    do: [session_id: session_id]

  defp session_metadata(_metadata), do: []

  def span_metadata(nil), do: []

  def span_metadata(span) do
    [trace_id: Span.hex_trace_id(span), span_id: Span.hex_span_id(span)]
  end

  def bounded_episode_event_name(event) do
    event
    |> Map.get(:name, Map.get(event, "name"))
    |> episode_event_label()
  end

  defp episode_event_label(name) when is_atom(name),
    do: name |> Atom.to_string() |> episode_event_label()

  defp episode_event_label(name) when is_binary(name) and name in @episode_event_names, do: name
  defp episode_event_label(_name), do: "other"

  def deliver_to_sink(metadata) do
    case Support.config() do
      %{event_sink: sink} when is_function(sink, 1) -> sink.(metadata)
      _ -> :ok
    end
  end
end
