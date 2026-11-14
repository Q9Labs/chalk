defmodule ChalkSync.ExternalOperationConsumer.Execution do
  @moduledoc """
  Runs one claimed external operation to a confirmed or terminal outcome.
  """

  require Logger
  alias ChalkSync.ExternalOperationConsumer.Dispatch
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation

  @max_attempts 100

  @doc false
  @spec execute_operation(
          EpisodeKey.t(),
          ExternalOperation.t(),
          {module(), term()} | nil,
          {module(), term()} | nil,
          (EpisodeKey.t(), String.t(), tuple() -> term()),
          pos_integer()
        ) :: :confirmed | :terminal_failure | :pending | :finalization_failure
  def execute_operation(
        episode,
        operation,
        media_plane,
        recording_plane,
        finalize,
        adapter_timeout_ms \\ ProviderCall.default_timeout_ms()
      )
      when is_function(finalize, 3) and is_integer(adapter_timeout_ms) and
             adapter_timeout_ms > 0 do
    result =
      if ExternalOperation.leave_cleanup?(operation) and operation.attempt_count >= @max_attempts,
        do: {:terminal_failure, :retry_exhausted},
        else:
          Dispatch.dispatch_with_context(
            episode,
            operation,
            media_plane,
            recording_plane,
            adapter_timeout_ms
          )

    settle(episode, operation, result, finalize)
  end

  defp settle(episode, operation, {:confirmed, authority}, finalize),
    do: finalize_confirmed(episode, operation, authority, finalize)

  defp settle(
         _episode,
         %{name: :role_transition_source_stop} = operation,
         {:terminal_failure, reason},
         _finalize
       ),
       do: keep_source_stop_pending(operation, reason)

  defp settle(episode, operation, {:terminal_failure, reason}, finalize),
    do: finalize_terminal_failure(episode, operation, reason, finalize)

  defp settle(_episode, %{name: :role_transition_source_stop}, :pending, _finalize), do: :pending

  defp settle(episode, operation, :pending, finalize) do
    if operation.attempt_count >= @max_attempts,
      do: finalize_terminal_failure(episode, operation, :retry_exhausted, finalize),
      else: :pending
  end

  # A person lost the right to publish, so Sync asks the SFU to stop the source until the SFU
  # confirms. Giving up would leave the source live with nothing left to revoke it, and a failed
  # stop would reject a role change that has already taken effect.
  defp keep_source_stop_pending(operation, reason) do
    Logger.warning(
      "sync external operation source stop stays pending: " <>
        "operation=#{operation.external_operation_id} reason=#{reason}"
    )

    :pending
  end

  defp finalize_confirmed(episode, operation, authority, finalize) do
    case finalize.(episode, operation.external_operation_id, {:confirmed, authority}) do
      {:ok, _decision} -> :confirmed
      result -> finalization_failure(operation.name, result)
    end
  end

  defp finalize_terminal_failure(episode, operation, reason, finalize) do
    case finalize.(episode, operation.external_operation_id, {:failed, reason}) do
      {:ok, _decision} -> :terminal_failure
      result -> finalization_failure(operation.name, result)
    end
  end

  defp finalization_failure(operation, result) do
    Logger.warning(
      "sync external operation finalization unavailable: operation=#{operation} " <>
        "result=#{inspect(result)}"
    )

    :finalization_failure
  end
end
