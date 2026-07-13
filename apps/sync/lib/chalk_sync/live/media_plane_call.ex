defmodule ChalkSync.Live.MediaPlaneCall do
  @moduledoc false

  @default_timeout_ms 5_000

  @spec invoke((-> term())) :: term() | {:error, :dependency_unavailable}
  def invoke(callback) when is_function(callback, 0) do
    timeout_ms =
      Application.get_env(
        :chalk_sync,
        :external_operation_adapter_timeout_ms,
        @default_timeout_ms
      )

    task =
      Task.Supervisor.async_nolink(ChalkSync.CommandTaskSupervisor, fn ->
        invoke_safely(callback)
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      _unavailable -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp invoke_safely(callback) do
    callback.()
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end
end
