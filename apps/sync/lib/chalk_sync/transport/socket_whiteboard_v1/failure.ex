defmodule ChalkSync.Transport.SocketWhiteboardV1.Failure do
  @moduledoc """
  Operation failures and close reasons a whiteboard-v1 peer sees.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.WhiteboardV1.Protocol

  def operation_failure(correlation_id, operation, failure, state) do
    {reason, recoverable} =
      case failure do
        {:error, reason} -> {reason, false}
        {:retryable, reason} -> {reason, true}
        _ -> {:unavailable, true}
      end

    code = normalize_error(reason)

    state = Lifecycle.observe_operation(state, operation, Atom.to_string(code))

    {:push,
     {:text,
      Protocol.operation_error(
        correlation_id,
        operation,
        code,
        recoverable,
        error_message(reason, code)
      )}, state}
  end

  defp normalize_error(code)
       when code in [
              :permission_denied,
              :invalid_payload,
              :stale_scene,
              :cursor_reset_required,
              :rate_limited,
              :overloaded,
              :storage_unavailable
            ] do
    code
  end

  defp normalize_error(:draw_policy_limit) do
    :rate_limited
  end

  defp normalize_error(_code) do
    :unavailable
  end

  defp error_message(:draw_policy_limit, _code) do
    "This Episode has reached its limit of drawing policy changes"
  end

  defp error_message(_reason, code) do
    error_message(code)
  end

  defp error_message(:permission_denied) do
    "Whiteboard permission denied"
  end

  defp error_message(:invalid_payload) do
    "Invalid whiteboard payload"
  end

  defp error_message(:stale_scene) do
    "Whiteboard scene changed"
  end

  defp error_message(:cursor_reset_required) do
    "Whiteboard snapshot required"
  end

  defp error_message(:rate_limited) do
    "Whiteboard cursor rate exceeded"
  end

  defp error_message(:overloaded) do
    "Whiteboard temporarily overloaded"
  end

  defp error_message(:storage_unavailable) do
    "Whiteboard storage unavailable"
  end

  defp error_message(:unavailable) do
    "Whiteboard unavailable"
  end

  def close_reason(:frame_too_large) do
    "frame too large"
  end

  def close_reason(:invalid_json) do
    "invalid JSON"
  end

  def close_reason(_reason) do
    "invalid whiteboard frame"
  end
end
