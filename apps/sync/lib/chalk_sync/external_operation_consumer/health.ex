defmodule ChalkSync.ExternalOperationConsumer.Health do
  @moduledoc """
  Health snapshot of one external-operation lane.
  """

  @worker_completion_grace_ms 5_000

  def health_snapshot(state) do
    now_ms = System.monotonic_time(:millisecond)

    %{
      last_success_at_ms: state.last_success_at_ms,
      consecutive_failures: state.consecutive_failures,
      confirmed_count: state.confirmed_count,
      terminal_failure_count: state.terminal_failure_count,
      retained_pending_count: state.retained_pending_count,
      active_work: not is_nil(state.active_work),
      active_work_age_ms: active_work_age_ms(state.active_work, now_ms),
      active_work_timeout_ms:
        state.page_size * state.adapter_timeout_ms + @worker_completion_grace_ms
    }
  end


  defp active_work_age_ms(nil, _now_ms), do: nil

  defp active_work_age_ms(active_work, now_ms) do
    max(now_ms - active_work.started_at_ms, 0)
  end
end
