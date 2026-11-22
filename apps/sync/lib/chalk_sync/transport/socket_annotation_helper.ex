defmodule ChalkSync.Transport.SocketAnnotationHelper do
  @moduledoc "Annotation-only attachment. It does not join an Episode or start any Sync streams."

  @behaviour WebSock

  alias ChalkSync.ProtocolV1
  alias ChalkSync.ScreenAnnotation.{Attachment, Availability, Presence, Repository}
  alias ChalkSync.Transport.DirectLimits
  alias ChalkSync.Transport.Socket.Annotation

  @attach_timeout_ms 5_000

  @impl true
  def init(observability: observability, client_ip: ip) do
    state = %{phase: :awaiting_attachment, observability: observability}

    if Availability.enabled?() do
      case DirectLimits.register(ip) do
        :ok -> challenge(state)
        {:error, _denial} -> stop(state)
      end
    else
      Annotation.stop_disabled_attachment(state)
    end
  end

  defp challenge(state) do
    nonce = Attachment.nonce()
    Process.send_after(self(), :attachment_timeout, @attach_timeout_ms)
    send(self(), :attachment_challenge)
    {:ok, Map.put(state, :nonce, nonce)}
  end

  @impl true
  def handle_info(:attachment_challenge, %{phase: :awaiting_attachment, nonce: nonce} = state) do
    frame = %{"type" => "annotation_helper_challenge", "version" => 1, "nonce" => nonce}
    {:push, {:text, JSON.encode!(frame)}, state}
  end

  def handle_info(:attachment_timeout, %{phase: :awaiting_attachment} = state), do: stop(state)
  def handle_info(:attachment_expired, state), do: stop(state)
  def handle_info(:annotation_tick, state), do: Annotation.tick(state)
  def handle_info(:annotation_changed, state), do: Annotation.changed(state)
  def handle_info(:annotation_presence_ready, state), do: Annotation.drain_presence(state)
  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def handle_in({wire, [opcode: :text]}, %{phase: :awaiting_attachment, nonce: nonce} = state)
      when byte_size(wire) <= 4_500 do
    with :ok <- require_availability(),
         {:ok, frame} <- JSON.decode(wire),
         {:ok, attachment} <- Attachment.verify(frame, nonce),
         {:ok, _actor, layer, now, _share} <- Repository.read(attachment.identity),
         true <- Attachment.matches?(layer, attachment, now),
         :ok <- DirectLimits.authenticated(attachment.identity.episode.tenant_id) do
      observe(:accepted)
      Process.send_after(self(), :attachment_expired, max(0, attachment.expires_at_ms - now))

      next =
        Map.merge(state, %{
          phase: :live,
          screen_annotation: true,
          identity: attachment.identity,
          attachment: attachment,
          annotation: nil,
          annotation_commands: []
        })

      Annotation.initial_snapshot(Annotation.enter(next))
    else
      {:error, :screen_annotation_disabled} ->
        observe(:rejected)
        Annotation.stop_disabled_attachment(state)

      _ ->
        observe(:rejected)
        stop(state)
    end
  end

  def handle_in({wire, [opcode: :text]}, %{phase: :live} = state)
      when byte_size(wire) <= 16_384 do
    with true <- System.system_time(:millisecond) < state.attachment.expires_at_ms,
         {:ok, {:screen_annotation, frame}} <- ProtocolV1.decode(wire),
         true <- permitted?(frame) do
      Annotation.handle(frame, state)
    else
      _ -> stop(state)
    end
  end

  def handle_in(_frame, state), do: stop(state)

  @impl true
  def terminate(_reason, _state), do: Presence.leave()

  defp require_availability do
    if Availability.enabled?(), do: :ok, else: {:error, :screen_annotation_disabled}
  end

  defp permitted?(%{"type" => "annotation_command", "command" => command}),
    do: Attachment.allowed_command?(command)

  defp permitted?(_frame), do: false

  defp observe(outcome),
    do:
      :telemetry.execute([:chalk, :sync, :annotation, :attachment], %{count: 1}, %{
        outcome: outcome
      })

  defp stop(state), do: {:stop, :normal, {1008, "annotation attachment ended"}, state}
end
