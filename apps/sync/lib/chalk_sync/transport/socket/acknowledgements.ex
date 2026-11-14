defmodule ChalkSync.Transport.Socket.Acknowledgements do
  @moduledoc """
  Frames a v1 client sends to confirm what it received or did: entry, delivery, recovery and
  directed requests.
  """

  require Logger

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder
  alias ChalkSync.Transport.Socket.Frames
  alias ChalkSync.Transport.Socket.Lifecycle

  @doc "The client confirmed it entered the Episode; the entry deadline stops."
  def entered(%{entry_confirmation: false} = state),
    do: Frames.protocol_error(:entry_confirmation_not_negotiated, state)

  def entered(%{identity: identity} = state) do
    case Stateholder.confirm_admission(identity) do
      {:ok, %{result: result}} when result in [:applied, :already_applied] ->
        Lifecycle.cancel_timer(state.entry_timer)

        {:push, {:text, Frames.encode_with_context(state, ProtocolV1.entered_ack())},
         %{state | entry_timer: nil}}

      {:ok, %{result: :superseded, reason: :entry_expired}} ->
        Lifecycle.stop(state, 1008, "entry timeout", :entry_timeout)

      {:ok, %{result: :superseded}} ->
        Lifecycle.stop(state, 1008, "policy violation", :admission_rejected)

      {:error, :entry_expired} ->
        Lifecycle.stop(state, 1008, "entry timeout", :entry_timeout)

      {:error, reason}
      when reason in [:stale_participant_generation, :invalid_admission_intent] ->
        Lifecycle.stop(state, 1008, "invalid token", :admission_rejected)

      {outcome, reason} when outcome in [:error, :retryable] ->
        Logger.warning("sync v1 entered failed: reason=#{reason}")
        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end

  @doc "A control-stream delivery acknowledgement; in the terminal phase it ends the connection."
  def delivery_ack(
        %{stream: :control, revision: revision, state_digest: digest},
        %{phase: :terminal, terminal_head: %{revision: revision, state_digest: digest}} = state
      ) do
    case Coordinator.acknowledge(state.coordinator, revision, digest, self()) do
      :ok ->
        Lifecycle.cancel_timer(state.terminal_ack_timer)

        Lifecycle.stop(
          %{state | terminal_ack_timer: nil},
          1000,
          "terminal event acknowledged",
          :normal
        )

      {:error, _reason} ->
        stop_delivery_failure(state)
    end
  end

  def delivery_ack(
        %{stream: :control, revision: revision, state_digest: digest},
        %{phase: :live} = state
      ) do
    case Coordinator.acknowledge(state.coordinator, revision, digest, self()) do
      :ok -> {:ok, state}
      {:error, _reason} -> stop_delivery_failure(state)
    end
  end

  def delivery_ack(_ack, state), do: Frames.protocol_error(:recovery_required, state)

  @doc "A recovery acknowledgement: a recovering socket treats a refusal as a failed delivery."
  def recovery_ack(ack, %{phase: :recovering} = state) do
    case acknowledge_recovery(ack, state) do
      :ok -> {:ok, state}
      {:error, _reason} -> stop_delivery_failure(state)
    end
  end

  def recovery_ack(ack, %{phase: :live} = state) do
    case acknowledge_recovery(ack, state) do
      :ok -> {:ok, state}
      {:error, _reason} -> Frames.protocol_error(:recovery_required, state)
    end
  end

  def recovery_ack(_ack, state), do: Frames.protocol_error(:recovery_required, state)

  def request_ack(request_id, %{phase: :live} = state) do
    case Coordinator.acknowledge_request(state.coordinator, state.identity, request_id, self()) do
      :ok -> {:ok, state}
      {:error, reason} -> Frames.protocol_error(reason, state)
    end
  end

  def request_ack(_request_id, state), do: Frames.protocol_error(:recovery_required, state)

  defp acknowledge_recovery(ack, state) do
    Coordinator.acknowledge_recovery(
      state.coordinator,
      ack.recovery_id,
      ack.revision,
      ack.state_digest,
      self()
    )
  end

  defp stop_delivery_failure(state),
    do: Lifecycle.stop(state, 1012, "delivery recovery required", :delivery_failure)
end
