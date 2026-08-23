defmodule ChalkSync.Admission.CursorBudget do
  @moduledoc "A lock-free, participant-scoped cursor token bucket."

  @uninitialized -9_223_372_036_854_775_808

  @enforce_keys [:state, :rate_max, :window_ms]
  defstruct [:state, :rate_max, :window_ms]

  @opaque t :: %__MODULE__{
            state: :atomics.atomics_ref(),
            rate_max: pos_integer(),
            window_ms: pos_integer()
          }

  @spec new(pos_integer(), pos_integer()) :: t()
  def new(rate_max, window_ms)
      when is_integer(rate_max) and rate_max > 0 and is_integer(window_ms) and window_ms > 0 do
    state = :atomics.new(1, signed: true)
    :atomics.put(state, 1, @uninitialized)
    %__MODULE__{state: state, rate_max: rate_max, window_ms: window_ms}
  end

  @spec admit(t(), integer()) :: :ok | {:error, :rate_limited}
  def admit(%__MODULE__{} = budget, now_ms) when is_integer(now_ms) do
    admit_current(budget, now_ms * budget.rate_max)
  end

  defp admit_current(budget, now_units) do
    current = :atomics.get(budget.state, 1)

    cond do
      current == @uninitialized ->
        exchange(budget, current, now_units + budget.window_ms, now_units)

      now_units < current - burst_tolerance(budget) ->
        {:error, :rate_limited}

      true ->
        next = max(now_units, current) + budget.window_ms
        exchange(budget, current, next, now_units)
    end
  end

  defp exchange(budget, current, next, now_units) do
    case :atomics.compare_exchange(budget.state, 1, current, next) do
      :ok -> :ok
      _actual -> admit_current(budget, now_units)
    end
  end

  defp burst_tolerance(budget), do: budget.window_ms * (budget.rate_max - 1)
end
